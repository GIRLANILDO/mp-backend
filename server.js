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
// ROTA 3 — Criar pagamento Pix de PARCELA (Mercado Pago)
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
        const hoje = new Date().toISOString();
        await docRef.update({
            pago: true,
            status: 'pago',
            paymentDate: hoje,
            paymentMethod: 'PIX',
            dataPagamento: hoje,
            meioPagamento: 'PIX (automático)'
        });
        console.log(`✅ Baixa automática: parcela ${docRef.id} paga via MP (paymentId: ${paymentId})`);
        // Grava notificação
        await db.collection('notificacoes').add({
            ownerId: ownerId,
            titulo: 'Pagamento Recebido!',
            mensagem: `Parcela ${docData.number}/${docData.total} de ${docData.clientName} — R$ ${parseFloat(docData.amount).toFixed(2).replace('.', ',')} pago via PIX`,
            lida: false,
            timestamp: new Date()
        });
    } catch (err) {
        console.error('Erro no webhook:', err.response?.data || err.message);
    }
});
// ============================================================
// ROTA 5 — Criar pagamento Pix de PARCELA (Asaas)       ← NOVO
// ============================================================
const ASAAS_BASE = process.env.ASAAS_BASE_URL || 'https://api.asaas.com/api/v3';

async function obterOuCriarClienteAsaas(apiKey, payerName, payerCpfCnpj, payerEmail) {
    const headers = { 'access_token': apiKey, 'Content-Type': 'application/json' };
    if (payerCpfCnpj) {
        const cpfLimpo = payerCpfCnpj.replace(/\D/g, '');
        const res = await axios.get(`${ASAAS_BASE}/customers?cpfCnpj=${cpfLimpo}&limit=1`, { headers });
        if (res.data.data && res.data.data.length > 0) return res.data.data[0].id;
    }
    const payload = { name: payerName || 'Cliente' };
    if (payerCpfCnpj) payload.cpfCnpj = payerCpfCnpj.replace(/\D/g, '');
    if (payerEmail)   payload.email    = payerEmail;
    const res = await axios.post(`${ASAAS_BASE}/customers`, payload, { headers });
    return res.data.id;
}

app.post('/criar-parcela-asaas', async (req, res) => {
    try {
        const { asaasApiKey, installmentId, amount, dueDate, description, payerName, payerCpfCnpj, payerEmail } = req.body;
        if (!asaasApiKey)   return res.status(400).json({ error: 'asaasApiKey obrigatório' });
        if (!installmentId) return res.status(400).json({ error: 'installmentId obrigatório' });
        if (!amount)        return res.status(400).json({ error: 'amount obrigatório' });
        if (!dueDate)       return res.status(400).json({ error: 'dueDate obrigatório' });

        const headers = { 'access_token': asaasApiKey, 'Content-Type': 'application/json' };

        // 1. Obtém/cria cliente no Asaas
        const customerId = await obterOuCriarClienteAsaas(asaasApiKey, payerName, payerCpfCnpj, payerEmail);

        // 2. Cria cobrança PIX
        const pagamentoRes = await axios.post(`${ASAAS_BASE}/payments`, {
            customer:          customerId,
            billingType:       'PIX',
            value:             Number(amount),
            dueDate:           dueDate,
            description:       description || `Parcela ${installmentId}`,
            externalReference: installmentId
        }, { headers });
        const pagamento = pagamentoRes.data;

        // 3. Busca QR Code
        const qrRes = await axios.get(`${ASAAS_BASE}/payments/${pagamento.id}/pixQrCode`, { headers });
        const qrData = qrRes.data;

        res.json({
            paymentId:     pagamento.id,
            qrCodeBase64:  qrData.encodedImage,
            pixCopiaECola: qrData.payload,
            status:        pagamento.status
        });
    } catch (err) {
        console.error('Erro /criar-parcela-asaas:', err.response?.data || err.message);
        res.status(500).json({ error: err.message });
    }
});
// ============================================================
// ROTA 6 — Webhook do Asaas                              ← NOVO
// Configure em: Asaas → Minha Conta → Integrações → Webhooks
// URL: https://intuitive-surprise-production-8572.up.railway.app/webhook/asaas
// Eventos: PAYMENT_RECEIVED, PAYMENT_CONFIRMED
// ============================================================
app.post('/webhook/asaas', async (req, res) => {
    res.sendStatus(200);
    try {
        // Valida token de segurança (configure ASAAS_WEBHOOK_TOKEN no Railway)
        const webhookToken = process.env.ASAAS_WEBHOOK_TOKEN;
        if (webhookToken) {
            const tokenRecebido = req.headers['asaas-access-token'];
            if (tokenRecebido !== webhookToken) {
                console.warn('[Asaas Webhook] Token inválido — ignorado.');
                return;
            }
        }

        const { event, payment } = req.body;
        if (!['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(event) || !payment) return;

        const installmentId = payment.externalReference;
        if (!installmentId) {
            console.log('Asaas Webhook: pagamento sem externalReference, ignorado.', payment.id);
            return;
        }

        const docRef = db.collection('installments').doc(installmentId);
        const snap = await docRef.get();
        if (!snap.exists) {
            console.log(`Asaas Webhook: parcela não encontrada: ${installmentId}`);
            return;
        }

        const data = snap.data();
        if (data.pago === true) return; // idempotência

        const hoje = new Date().toISOString();
        await docRef.update({
            pago: true,
            status: 'pago',
            paymentDate: hoje,
            paymentMethod: 'PIX',
            dataPagamento: hoje,
            meioPagamento: 'PIX (automático)',
            asaasPaymentId: payment.id
        });

        await db.collection('notificacoes').add({
            ownerId:   data.ownerId,
            titulo:    'Pagamento Recebido!',
            mensagem:  `Parcela ${data.number}/${data.total} de ${data.clientName} — R$ ${parseFloat(data.amount).toFixed(2).replace('.', ',')} pago via PIX (Asaas)`,
            lida:      false,
            timestamp: new Date()
        });

        console.log(`✅ Baixa automática Asaas: parcela ${installmentId} (paymentId: ${payment.id})`);
    } catch (err) {
        console.error('Erro no webhook Asaas:', err.response?.data || err.message);
    }
});
// ============================================================
// VERIFICAÇÃO AUTOMÁTICA — a cada 5 minutos confere parcelas pendentes
// ============================================================
const verificarParcelasPendentes = async () => {
    try {
        console.log('🔍 Verificando parcelas pendentes...');
        const snapshot = await db.collection('installments')
            .where('pago', '==', false)
            .where('status', '==', 'pendente')
            .get();
        if (snapshot.empty) return;
        let baixasFeitas = 0;
        for (const doc of snapshot.docs) {
            const data = doc.data();
            const mpPaymentId = data.mpPaymentId;
            // Ignora parcelas sem QR do MP (estáticas ou do Asaas — essas usam webhook)
            if (!mpPaymentId || mpPaymentId === 'null') continue;
            const ownerId = data.ownerId;
            if (!ownerId) continue;
            try {
                const settingsDoc = await db.collection('settings').doc(ownerId).get();
                if (!settingsDoc.exists) continue;
                const mpToken = settingsDoc.data()?.mpAccessToken;
                if (!mpToken) continue;
                const statusRes = await axios.get(
                    `https://api.mercadopago.com/v1/payments/${mpPaymentId}`,
                    { headers: { Authorization: `Bearer ${mpToken}` } }
                );
                if (statusRes.data.status !== 'approved') continue;
                const hoje = new Date().toISOString();
                await doc.ref.update({
                    pago: true,
                    status: 'pago',
                    paymentDate: hoje,
                    paymentMethod: 'PIX',
                    dataPagamento: hoje,
                    meioPagamento: 'PIX (automático)'
                });
                await db.collection('notificacoes').add({
                    ownerId: ownerId,
                    titulo: 'Pagamento Recebido!',
                    mensagem: `Parcela ${data.number}/${data.total} de ${data.clientName} — R$ ${parseFloat(data.amount).toFixed(2).replace('.', ',')} pago via PIX`,
                    lida: false,
                    timestamp: new Date()
                });
                baixasFeitas++;
                console.log(`✅ Baixa automática (verificação): parcela ${doc.id} (paymentId: ${mpPaymentId})`);
            } catch (e) {
                continue;
            }
        }
        if (baixasFeitas > 0) {
            console.log(`✅ Verificação concluída: ${baixasFeitas} baixa(s) feita(s)`);
        }
    } catch (err) {
        console.error('Erro na verificação automática:', err.message);
    }
};
setInterval(verificarParcelasPendentes, 5 * 60 * 1000);
setTimeout(verificarParcelasPendentes, 10000);
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
