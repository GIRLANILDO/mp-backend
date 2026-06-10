const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// ============================================================
// FIREBASE ADMIN SDK
// ============================================================
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const serviceAccount = {
    type: "service_account",
    project_id: "sisvenda-775d9",
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
};

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ============================================================
// MERCADO PAGO
// ============================================================
const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

// ============================================================
// TABELA DE PREÇOS — LICENÇAS
// ============================================================
const PRECOS = {
    triagem: { 30: 40,  60: 75,  90: 110 },
    agenda:  { 30: 80,  60: 150, 90: 220 },
    vendas:  { 30: 120, 60: 220, 90: 320 }
};

// ============================================================
// ROTA 1 — Criar pagamento de LICENÇA
// ============================================================
app.post('/criar-pagamento', async (req, res) => {
    try {
        const body    = req.body;
        const dias    = parseInt(body.metadata?.dias) || 30;
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
// ROTA 2 — Verificar status de LICENÇA
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
// ROTA 3 — Criar pagamento Pix de PARCELA
// ============================================================
app.post('/criar-parcela', async (req, res) => {
    try {
        const { mpAccessToken, installmentId, amount, dueDate, description, payerEmail } = req.body;

        if (!mpAccessToken) return res.status(400).json({ error: 'Token da ótica não informado.' });
        if (!installmentId) return res.status(400).json({ error: 'ID da parcela não informado.' });
        if (!amount || amount <= 0) return res.status(400).json({ error: 'Valor inválido.' });

        const base = dueDate ? new Date(dueDate + 'T12:00:00') : new Date();
        const expiration = new Date(base);
        expiration.setFullYear(expiration.getFullYear() + 1);

        const pad = (n) => String(n).padStart(2, '0');
        const expirationISO = expiration.getUTCFullYear() + '-' +
            pad(expiration.getUTCMonth()+1) + '-' +
            pad(expiration.getUTCDate()) + 'T' +
            pad(expiration.getUTCHours()) + ':' +
            pad(expiration.getUTCMinutes()) + ':' +
            pad(expiration.getUTCSeconds()) + '.000-04:00';

        console.log('date_of_expiration enviado:', expirationISO);

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
                metadata: {
                    installment_id: installmentId,
                    tipo: 'parcela'
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${mpAccessToken}`,
                    'Content-Type': 'application/json',
                    'X-Idempotency-Key': Date.now().toString()
                }
            }
        );

        const data = response.data;
        const qrCodeBase64 = data.point_of_interaction?.transaction_data?.qr_code_base64 || null;
        const qrCode       = data.point_of_interaction?.transaction_data?.qr_code || null;

        res.json({ paymentId: data.id, status: data.status, qrCodeBase64, qrCode });

    } catch (err) {
        console.error('Erro /criar-parcela:', JSON.stringify(err.response?.data || err.message));
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ROTA 4 — Webhook do Mercado Pago
// ============================================================
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);

    try {
        const { type, data } = req.body;
        if (type !== 'payment') return;

        const paymentId = data?.id;
        if (!paymentId) return;

        // 1. Busca a parcela pelo mpPaymentId no Firestore
        const snapshot = await db.collection('installments')
            .where('mpPaymentId', '==', String(paymentId))
            .limit(1)
            .get();

        if (snapshot.empty) {
            console.log(`Webhook: parcela não encontrada para paymentId ${paymentId}`);
            return;
        }

        const docRef = snapshot.docs[0].ref;
        const docData = snapshot.docs[0].data();
        const ownerId = docData.ownerId;

        if (docData.pago === true) return;

        // 2. Busca o token da ótica no settings
        let mpToken = null;
        if (ownerId) {
            const settingsDoc = await db.collection('settings').doc(ownerId).get();
            if (settingsDoc.exists) {
                mpToken = settingsDoc.data()?.mpAccessToken || null;
            }
        }

        if (!mpToken) {
            console.log(`Webhook: token não encontrado para ownerId ${ownerId}`);
            return;
        }

        // 3. Confirma o status no MP
        const statusRes = await axios.get(
            `https://api.mercadopago.com/v1/payments/${paymentId}`,
            { headers: { Authorization: `Bearer ${mpToken}` } }
        );

        if (statusRes.data.status !== 'approved') return;

        // 4. Dá baixa na parcela
        await docRef.update({
            pago: true,
            status: 'pago',
            dataPagamento: new Date().toISOString(),
            meioPagamento: 'PIX (automático)'
        });

        console.log(`✅ Baixa automática: parcela ${docRef.id} paga via MP (paymentId: ${paymentId})`);

    } catch (err) {
        console.error('Erro no webhook:', err.response?.data || err.message);
    }
});

// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
