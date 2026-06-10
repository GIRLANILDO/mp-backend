const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// ============================================================
// CREDENCIAIS
// ============================================================
const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN; // Token principal (licenças)

// Firebase REST API (para o webhook dar baixa nas parcelas)
const FIREBASE_PROJECT = 'sisvenda-775d9';
const FIREBASE_API_KEY  = process.env.FIREBASE_API_KEY; // Adicione no Railway

// ============================================================
// TABELA DE PREÇOS — LICENÇAS DO SISTEMA
// ============================================================
const PRECOS = {
    triagem: { 30: 40,  60: 75,  90: 110  },
    agenda:  { 30: 80,  60: 150, 90: 220  },
    vendas:  { 30: 120, 60: 220, 90: 320  }
};

// ============================================================
// ROTA 1 — Criar pagamento de LICENÇA (já existia)
// ============================================================
app.post('/criar-pagamento', async (req, res) => {
    try {
        const body   = req.body;
        const dias   = parseInt(body.metadata?.dias) || 30;
        const sistema = body.metadata?.sistema || 'triagem';
        const tabela  = PRECOS[sistema] || PRECOS['triagem'];
        const preco   = tabela[dias];

        if (!preco) return res.status(400).json({ error: 'Plano inválido.' });

        const response = await axios.post(
            'https://api.mercadopago.com/v1/payments',
            {
                transaction_amount: preco,
                description: `Licença ${dias} dias - ${sistema}`,
                payment_method_id: 'pix',
                payer: {
                    email: body.payer.email,
                    first_name: 'Cliente',
                    last_name: 'Otica',
                    identification: { type: 'CPF', number: '00000000000' }
                },
                metadata: body.metadata || {}
            },
            {
                headers: {
                    Authorization: `Bearer ${ACCESS_TOKEN}`,
                    'Content-Type': 'application/json',
                    'X-Idempotency-Key': Date.now().toString()
                }
            }
        );

        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ROTA 2 — Verificar status de pagamento de LICENÇA (já existia)
// ============================================================
app.get('/status/:id', async (req, res) => {
    try {
        const response = await axios.get(
            `https://api.mercadopago.com/v1/payments/${req.params.id}`,
            { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
        );
        res.json({ status: response.data.status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ROTA 3 — Criar pagamento Pix de PARCELA (nova)
//
// Body esperado:
// {
//   mpAccessToken: "APP_USR-...",   <- token da ótica
//   installmentId: "abc123",        <- ID da parcela no Firestore
//   amount: 150.00,                 <- valor da parcela
//   dueDate: "2025-08-10",          <- data de vencimento (YYYY-MM-DD)
//   description: "Parcela 2/6 - Maria Silva",
//   payerEmail: "cliente@email.com"
// }
// ============================================================
app.post('/criar-parcela', async (req, res) => {
    try {
        const {
            mpAccessToken,
            installmentId,
            amount,
            dueDate,
            description,
            payerEmail
        } = req.body;

        if (!mpAccessToken) return res.status(400).json({ error: 'Token da ótica não informado.' });
        if (!installmentId) return res.status(400).json({ error: 'ID da parcela não informado.' });
        if (!amount || amount <= 0) return res.status(400).json({ error: 'Valor inválido.' });

        // Expiração: 1 ano a partir do vencimento da parcela (ou hoje se não informado)
        const base = dueDate ? new Date(dueDate + 'T12:00:00') : new Date();
        const expiration = new Date(base);
        expiration.setFullYear(expiration.getFullYear() + 1);
        const expirationISO = expiration.toISOString().replace('.000', '+00:00');

        const response = await axios.post(
            'https://api.mercadopago.com/v1/payments',
            {
                transaction_amount: parseFloat(amount),
                description: description || `Parcela - ${installmentId}`,
                payment_method_id: 'pix',
                date_of_expiration: expirationISO,
                payer: {
                    email: payerEmail || 'cliente@otica.com',
                    first_name: 'Cliente',
                    last_name: 'Otica',
                    identification: { type: 'CPF', number: '00000000000' }
                },
                // Guardamos o installmentId nos metadados para o webhook identificar
                metadata: {
                    installment_id: installmentId,
                    tipo: 'parcela'
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${mpAccessToken}`,
                    'Content-Type': 'application/json',
                    'X-Idempotency-Key': `parcela-${installmentId}-${Date.now()}`
                }
            }
        );

        const data = response.data;
        const qrCodeBase64 = data.point_of_interaction?.transaction_data?.qr_code_base64 || null;
        const qrCode       = data.point_of_interaction?.transaction_data?.qr_code || null;

        res.json({
            paymentId: data.id,
            status: data.status,
            qrCodeBase64,
            qrCode
        });

    } catch (err) {
        console.error('Erro /criar-parcela:', err.response?.data || err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ROTA 4 — Webhook do Mercado Pago (nova)
//
// O MP chama esta rota quando um pagamento é aprovado.
// Ela busca o installment_id nos metadados e dá baixa no Firebase.
//
// URL para cadastrar no painel de cada ótica:
// https://intuitive-surprise-production-8572.up.railway.app/webhook
// ============================================================
app.post('/webhook', async (req, res) => {
    // Responde 200 imediatamente para o MP não reenviar
    res.sendStatus(200);

    try {
        const { type, data } = req.body;

        // Só processa notificações de pagamento aprovado
        if (type !== 'payment') return;

        const paymentId = data?.id;
        if (!paymentId) return;

        // Precisamos descobrir qual token usar para consultar este pagamento.
        // Como o webhook não informa o token da ótica, consultamos o Firebase
        // para encontrar a parcela pelo paymentId e depois obter o token da ótica.
        // Estratégia: buscar a parcela no Firestore via REST API.

        // 1. Busca a parcela pelo mpPaymentId no Firestore
        const queryUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery?key=${FIREBASE_API_KEY}`;

        const queryBody = {
            structuredQuery: {
                from: [{ collectionId: 'installments' }],
                where: {
                    fieldFilter: {
                        field: { fieldPath: 'mpPaymentId' },
                        op: 'EQUAL',
                        value: { stringValue: String(paymentId) }
                    }
                },
                limit: 1
            }
        };

        const queryRes = await axios.post(queryUrl, queryBody);
        const docs = queryRes.data;

        if (!docs || !docs[0]?.document) {
            console.log(`Webhook: parcela não encontrada para paymentId ${paymentId}`);
            return;
        }

        const docPath = docs[0].document.name; // ex: projects/.../documents/installments/ABC123
        const fields  = docs[0].document.fields;
        const ownerId = fields?.ownerId?.stringValue;

        // Se já está pago, ignora
        if (fields?.pago?.booleanValue === true) return;

        // 2. Busca o token da ótica no settings/{ownerId}
        let mpToken = null;
        if (ownerId) {
            const settingsUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/settings/${ownerId}?key=${FIREBASE_API_KEY}`;
            const settingsRes = await axios.get(settingsUrl);
            mpToken = settingsRes.data?.fields?.mpAccessToken?.stringValue || null;
        }

        if (!mpToken) {
            console.log(`Webhook: token não encontrado para ownerId ${ownerId}`);
            return;
        }

        // 3. Confirma o status do pagamento diretamente no MP com o token da ótica
        const statusRes = await axios.get(
            `https://api.mercadopago.com/v1/payments/${paymentId}`,
            { headers: { Authorization: `Bearer ${mpToken}` } }
        );

        if (statusRes.data.status !== 'approved') return;

        // 4. Dá baixa na parcela no Firestore
        const hoje = new Date().toISOString();
        const installmentId = docPath.split('/').pop();

        const patchUrl = `https://firestore.googleapis.com/v1/${docPath}?key=${FIREBASE_API_KEY}&updateMask.fieldPaths=pago&updateMask.fieldPaths=dataPagamento&updateMask.fieldPaths=meioPagamento`;

        await axios.patch(patchUrl, {
            fields: {
                pago:          { booleanValue: true },
                dataPagamento: { stringValue: hoje },
                meioPagamento: { stringValue: 'PIX (automático)' }
            }
        });

        console.log(`✅ Baixa automática: parcela ${installmentId} paga via MP (paymentId: ${paymentId})`);

    } catch (err) {
        console.error('Erro no webhook:', err.response?.data || err.message);
    }
});

// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
