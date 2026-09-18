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
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');   // ← FCM
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
// HELPER — Envia push notification FCM para todos os dispositivos do dono
// ============================================================
async function enviarPushNotification(ownerId, titulo, mensagem) {
    try {
        const settingsDoc = await db.collection('settings').doc(ownerId).get();
        if (!settingsDoc.exists) return;
        const tokens = settingsDoc.data()?.fcmTokens || [];
        if (tokens.length === 0) return;

        const messaging = getMessaging();
        const tokensInvalidos = [];

        await Promise.all(tokens.map(async (token) => {
            try {
                await messaging.send({
                    token,
                    notification: { title: titulo, body: mensagem },
                    webpush: {
                        notification: {
                            icon: '/icon-192.png',
                            badge: '/icon-192.png',
                            vibrate: [200, 100, 200],
                            requireInteraction: true
                        },
                        fcmOptions: { link: '/' }
                    }
                });
            } catch (err) {
                if (
                    err.code === 'messaging/invalid-registration-token' ||
                    err.code === 'messaging/registration-token-not-registered'
                ) {
                    tokensInvalidos.push(token);
                } else {
                    console.warn('Erro FCM para token:', err.message);
                }
            }
        }));

        if (tokensInvalidos.length > 0) {
            await db.collection('settings').doc(ownerId).update({
                fcmTokens: FieldValue.arrayRemove(...tokensInvalidos)
            });
            console.log(`🗑️ ${tokensInvalidos.length} token(s) FCM inválido(s) removido(s) de ${ownerId}`);
        }

        console.log(`📲 Push enviado para ${tokens.length - tokensInvalidos.length} dispositivo(s) de ${ownerId}: "${titulo}"`);
    } catch (err) {
        console.error('Erro ao enviar push notification:', err.message);
    }
}

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
        const statusRes = await axios.get(
            `https://api.mercadopago.com/v1/payments/${paymentId}`,
            { headers: { Authorization: `Bearer ${mpToken}` } }
        );
        if (statusRes.data.status !== 'approved') return;
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
        const mensagemPush = `Parcela ${docData.number}/${docData.total} de ${docData.clientName} — R$ ${parseFloat(docData.amount).toFixed(2).replace('.', ',')} pago via PIX`;
        await db.collection('notificacoes').add({
            ownerId: ownerId,
            titulo: 'Pagamento Recebido!',
            mensagem: mensagemPush,
            lida: false,
            timestamp: new Date()
        });
        await enviarPushNotification(ownerId, '💰 Pagamento Recebido!', mensagemPush);
    } catch (err) {
        console.error('Erro no webhook:', err.response?.data || err.message);
    }
});
// ============================================================
// ROTA 5 — Criar pagamento Pix de PARCELA (Asaas) — legado
// ============================================================
const ASAAS_BASE = process.env.ASAAS_BASE_URL || 'https://api.asaas.com/api/v3';
async function obterOuCriarClienteAsaas(apiKey, payerName, payerCpfCnpj, payerEmail) {
    const headers = { 'access_token': apiKey, 'Content-Type': 'application/json' };
    console.log('[Asaas] Base URL:', ASAAS_BASE);
    if (payerCpfCnpj) {
        const cpfLimpo = payerCpfCnpj.replace(/\D/g, '');
        console.log('[Asaas] Buscando cliente por CPF:', cpfLimpo);
        try {
            const res = await axios.get(`${ASAAS_BASE}/customers?cpfCnpj=${cpfLimpo}&limit=1`, { headers });
            if (res.data.data && res.data.data.length > 0) {
                console.log('[Asaas] Cliente encontrado:', res.data.data[0].id);
                return res.data.data[0].id;
            }
        } catch(e) {
            console.error('[Asaas] Erro ao buscar cliente:', e.response?.status, JSON.stringify(e.response?.data));
        }
    }
    console.log('[Asaas] Criando cliente:', payerName);
    const payload = { name: payerName || 'Cliente' };
    if (payerCpfCnpj) payload.cpfCnpj = payerCpfCnpj.replace(/\D/g, '');
    if (payerEmail)   payload.email    = payerEmail;
    console.log('[Asaas] Payload cliente:', JSON.stringify(payload));
    const res = await axios.post(`${ASAAS_BASE}/customers`, payload, { headers });
    console.log('[Asaas] Cliente criado:', res.data.id);
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
        const customerId = await obterOuCriarClienteAsaas(asaasApiKey, payerName, payerCpfCnpj, payerEmail);
        console.log('[Asaas] Criando pagamento para cliente:', customerId, 'valor:', amount, 'venc:', dueDate);
        const pagamentoRes = await axios.post(`${ASAAS_BASE}/payments`, {
            customer:          customerId,
            billingType:       'PIX',
            value:             Number(amount),
            dueDate:           dueDate,
            description:       description || `Parcela ${installmentId}`,
            externalReference: installmentId
        }, { headers });
        const pagamento = pagamentoRes.data;
        console.log('[Asaas] Pagamento criado:', pagamento.id, 'status:', pagamento.status);
        console.log('[Asaas] Buscando QR Code para pagamento:', pagamento.id);
        const qrRes = await axios.get(`${ASAAS_BASE}/payments/${pagamento.id}/pixQrCode`, { headers });
        const qrData = qrRes.data;
        console.log('[Asaas] QR Code obtido, encodedImage length:', qrData.encodedImage?.length);
        res.json({
            paymentId:     pagamento.id,
            qrCodeBase64:  qrData.encodedImage,
            pixCopiaECola: qrData.payload,
            status:        pagamento.status
        });
    } catch (err) {
        console.error('[Asaas] Erro status:', err.response?.status);
        console.error('[Asaas] Erro data:', JSON.stringify(err.response?.data));
        console.error('[Asaas] Erro msg:', err.message);
        res.status(500).json({ error: err.message });
    }
});
// ============================================================
// ROTA 6 — Webhook do Asaas
// ============================================================
app.post('/webhook/asaas', async (req, res) => {
    res.sendStatus(200);
    try {
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
        let docRef = null;
        let data   = null;
        const externalRef = payment.externalReference;
        if (externalRef) {
            const directSnap = await db.collection('installments').doc(externalRef).get();
            if (directSnap.exists) {
                docRef = directSnap.ref;
                data   = directSnap.data();
            }
        }
        if (!docRef) {
            const q = await db.collection('installments')
                .where('asaasPaymentId', '==', payment.id)
                .limit(1)
                .get();
            if (!q.empty) {
                docRef = q.docs[0].ref;
                data   = q.docs[0].data();
            }
        }
        if (!docRef || !data) {
            console.log(`Asaas Webhook: parcela não encontrada. ref=${externalRef}, paymentId=${payment.id}`);
            return;
        }
        if (data.pago === true) return;
        const formaPagamento = payment.billingType === 'BOLETO'
            ? 'Boleto (automático)'
            : 'PIX (automático)';
        const hoje = new Date().toISOString();
        await docRef.update({
            pago: true,
            status: 'pago',
            paymentDate: hoje,
            paymentMethod: payment.billingType === 'BOLETO' ? 'BOLETO' : 'PIX',
            dataPagamento: hoje,
            meioPagamento: formaPagamento,
            asaasPaymentId: payment.id
        });
        const mensagemPush = `Parcela ${data.number}/${data.total} de ${data.clientName} — R$ ${parseFloat(data.amount).toFixed(2).replace('.', ',')} pago via ${formaPagamento}`;
        await db.collection('notificacoes').add({
            ownerId:   data.ownerId,
            titulo:    'Pagamento Recebido!',
            mensagem:  mensagemPush,
            lida:      false,
            timestamp: new Date()
        });
        await enviarPushNotification(data.ownerId, '💰 Pagamento Recebido!', mensagemPush);
        console.log(`✅ Baixa automática Asaas: parcela ${docRef.id} (${formaPagamento}, paymentId: ${payment.id})`);
    } catch (err) {
        console.error('Erro no webhook Asaas:', err.response?.data || err.message);
    }
});
// ============================================================
// ROTA 7 — Criar BOLETO BANCÁRIO de PARCELA (Asaas)
// ============================================================
app.post('/asaas/criar-parcela', async (req, res) => {
    try {
        const {
            asaasToken, asaasAmbiente,
            clientName, cpf, phone, email,
            installmentId, amount, dueDate, description
        } = req.body;

        if (!asaasToken)    return res.status(400).json({ error: 'asaasToken obrigatório' });
        if (!installmentId) return res.status(400).json({ error: 'installmentId obrigatório' });
        if (!amount)        return res.status(400).json({ error: 'amount obrigatório' });
        if (!dueDate)       return res.status(400).json({ error: 'dueDate obrigatório' });

        const base = asaasAmbiente === 'producao'
            ? 'https://api.asaas.com/v3'
            : 'https://sandbox.asaas.com/api/v3';

        const headers = { 'access_token': asaasToken, 'Content-Type': 'application/json' };

        let customerId = null;
        if (cpf) {
            const cpfLimpo = cpf.replace(/\D/g, '');
            try {
                const buscaRes = await axios.get(
                    `${base}/customers?cpfCnpj=${cpfLimpo}&limit=1`,
                    { headers }
                );
                if (buscaRes.data.data && buscaRes.data.data.length > 0) {
                    customerId = buscaRes.data.data[0].id;
                    console.log('[Asaas Boleto] Cliente encontrado:', customerId);
                }
            } catch(e) {
                console.warn('[Asaas Boleto] Erro ao buscar cliente:', e.response?.status, JSON.stringify(e.response?.data));
            }
        }

        if (!customerId) {
            const payload = { name: clientName || 'Cliente' };
            if (cpf)   payload.cpfCnpj = cpf.replace(/\D/g, '');
            if (email) payload.email   = email;
            if (phone) payload.mobilePhone = phone.replace(/\D/g, '');
            const criarRes = await axios.post(`${base}/customers`, payload, { headers });
            customerId = criarRes.data.id;
            console.log('[Asaas Boleto] Cliente criado:', customerId);
        }

        const pagamentoRes = await axios.post(`${base}/payments`, {
            customer:          customerId,
            billingType:       'BOLETO',
            value:             Number(amount),
            dueDate:           dueDate,
            description:       description || `Parcela ${installmentId}`,
            externalReference: installmentId
        }, { headers });

        const pagamento = pagamentoRes.data;
        console.log('[Asaas Boleto] Boleto criado:', pagamento.id, '| status:', pagamento.status);

        res.json({
            paymentId:  pagamento.id,
            boletoUrl:  pagamento.bankSlipUrl || null,
            invoiceUrl: pagamento.invoiceUrl  || null,
            pixQrCode:  pagamento.pixQrCode   || null,
            status:     pagamento.status
        });
    } catch (err) {
        console.error('[Asaas Boleto] Erro status:', err.response?.status);
        console.error('[Asaas Boleto] Erro data:', JSON.stringify(err.response?.data));
        console.error('[Asaas Boleto] Erro msg:', err.message);
        res.status(500).json({ error: err.message, details: err.response?.data });
    }
});
// ============================================================
// ROTA 8 — Criar CARNÊ NATIVO no Asaas
// ============================================================
app.post('/asaas/criar-carne', async (req, res) => {
    try {
        const {
            asaasToken, asaasAmbiente,
            clientName, cpf, phone, email,
            saleId, installmentCount, installmentValue, firstDueDate, description
        } = req.body;

        if (!asaasToken)       return res.status(400).json({ error: 'asaasToken obrigatório' });
        if (!saleId)           return res.status(400).json({ error: 'saleId obrigatório' });
        if (!installmentCount) return res.status(400).json({ error: 'installmentCount obrigatório' });
        if (!installmentValue) return res.status(400).json({ error: 'installmentValue obrigatório' });
        if (!firstDueDate)     return res.status(400).json({ error: 'firstDueDate obrigatório' });

        const base = asaasAmbiente === 'producao'
            ? 'https://api.asaas.com/v3'
            : 'https://sandbox.asaas.com/api/v3';

        const headers = { 'access_token': asaasToken, 'Content-Type': 'application/json' };

        let customerId = null;
        if (cpf) {
            const cpfLimpo = cpf.replace(/\D/g, '');
            try {
                const buscaRes = await axios.get(`${base}/customers?cpfCnpj=${cpfLimpo}&limit=1`, { headers });
                if (buscaRes.data.data?.length > 0) {
                    customerId = buscaRes.data.data[0].id;
                    console.log('[Asaas Carnê] Cliente encontrado:', customerId);
                }
            } catch(e) { console.warn('[Asaas Carnê] Erro ao buscar cliente:', e.response?.data); }
        }
        if (!customerId) {
            const payload = { name: clientName || 'Cliente' };
            if (cpf)   payload.cpfCnpj    = cpf.replace(/\D/g, '');
            if (email) payload.email       = email;
            if (phone) payload.mobilePhone = phone.replace(/\D/g, '');
            const criarRes = await axios.post(`${base}/customers`, payload, { headers });
            customerId = criarRes.data.id;
            console.log('[Asaas Carnê] Cliente criado:', customerId);
        }

        const pagamentoRes = await axios.post(`${base}/payments`, {
            customer:          customerId,
            billingType:       'BOLETO',
            dueDate:           firstDueDate,
            description:       description || `Carnê ${installmentCount}x - ${clientName}`,
            externalReference: saleId,
            installmentCount:  Number(installmentCount),
            installmentValue:  Number(installmentValue)
        }, { headers });

        const installmentGroupId = pagamentoRes.data.installment;
        console.log('[Asaas Carnê] Parcelamento criado, installmentId:', installmentGroupId);

        const pagamentosRes = await axios.get(
            `${base}/payments?installment=${installmentGroupId}&limit=100`,
            { headers }
        );
        const pagamentos = (pagamentosRes.data.data || [])
            .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

        const payments = pagamentos.map((p, i) => ({
            number:    i + 1,
            paymentId: p.id,
            boletoUrl: p.bankSlipUrl || null,
            dueDate:   p.dueDate,
            status:    p.status
        }));

        res.json({ installmentId: installmentGroupId, payments });
    } catch (err) {
        console.error('[Asaas Carnê] Erro status:', err.response?.status);
        console.error('[Asaas Carnê] Erro data:', JSON.stringify(err.response?.data));
        res.status(500).json({ error: err.message, details: err.response?.data });
    }
});
// ============================================================
// ROTA 9 — Proxy: serve o PDF do carnê Asaas
// ============================================================
app.get('/asaas/carne/:saleId', async (req, res) => {
    try {
        const { saleId } = req.params;
        const saleDoc = await db.collection('sales').doc(saleId).get();
        if (!saleDoc.exists) return res.status(404).json({ error: 'Venda não encontrada' });
        const sale = saleDoc.data();
        const ownerId       = sale.ownerId || sale.userId;
        const installmentId = sale.asaasInstallmentId;
        if (!installmentId) return res.status(404).json({ error: 'Carnê Asaas não gerado para esta venda' });
        const settingsDoc = await db.collection('settings').doc(ownerId).get();
        if (!settingsDoc.exists) return res.status(404).json({ error: 'Configurações não encontradas' });
        const settings      = settingsDoc.data();
        const asaasToken    = settings?.asaasToken;
        const asaasAmbiente = settings?.asaasAmbiente || 'sandbox';
        if (!asaasToken) return res.status(400).json({ error: 'Token Asaas não configurado' });
        const base = asaasAmbiente === 'producao'
            ? 'https://api.asaas.com/v3'
            : 'https://sandbox.asaas.com/api/v3';
        console.log(`[Asaas Carnê PDF] Buscando carnê para venda ${saleId}, installmentId ${installmentId}`);
        const pdfRes = await axios.get(
            `${base}/installments/${installmentId}/paymentBook`,
            { headers: { 'access_token': asaasToken }, responseType: 'stream' }
        );
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="carne-${saleId}.pdf"`);
        pdfRes.data.pipe(res);
        console.log(`[Asaas Carnê PDF] PDF enviado para venda ${saleId}`);
    } catch (err) {
        console.error('[Asaas Carnê PDF] Erro:', err.response?.status, err.message);
        res.status(500).json({ error: err.message });
    }
});
// ============================================================
// ROTA 10 — Cancelar PAGAMENTO INDIVIDUAL no Asaas
// ============================================================
app.post('/asaas/cancelar-pagamento', async (req, res) => {
    try {
        const { asaasToken, asaasAmbiente, paymentId } = req.body;
        if (!asaasToken) return res.status(400).json({ error: 'asaasToken obrigatório' });
        if (!paymentId)  return res.status(400).json({ error: 'paymentId obrigatório' });
        const base = asaasAmbiente === 'producao'
            ? 'https://api.asaas.com/v3'
            : 'https://sandbox.asaas.com/api/v3';
        const r = await axios.post(
            `${base}/payments/${paymentId}/cancel`, {},
            { headers: { 'access_token': asaasToken, 'Content-Type': 'application/json' } }
        );
        console.log(`[Asaas] Pagamento ${paymentId} cancelado. Status: ${r.data.status}`);
        res.json(r.data);
    } catch (err) {
        console.error('[Asaas] Erro ao cancelar pagamento:', err.response?.status, JSON.stringify(err.response?.data));
        res.status(err.response?.status || 500).json({ error: err.message, details: err.response?.data });
    }
});
// ============================================================
// ROTA 11 — Cancelar CARNÊ INTEIRO no Asaas
// ============================================================
app.post('/asaas/cancelar-carne', async (req, res) => {
    try {
        const { asaasToken, asaasAmbiente, installmentId } = req.body;
        if (!asaasToken)    return res.status(400).json({ error: 'asaasToken obrigatório' });
        if (!installmentId) return res.status(400).json({ error: 'installmentId obrigatório' });
        const base = asaasAmbiente === 'producao'
            ? 'https://api.asaas.com/v3'
            : 'https://sandbox.asaas.com/api/v3';
        const r = await axios.post(
            `${base}/installments/${installmentId}/cancel`, {},
            { headers: { 'access_token': asaasToken, 'Content-Type': 'application/json' } }
        );
        console.log(`[Asaas] Carnê ${installmentId} cancelado.`);
        res.json(r.data);
    } catch (err) {
        console.error('[Asaas] Erro ao cancelar carnê:', err.response?.status, JSON.stringify(err.response?.data));
        res.status(err.response?.status || 500).json({ error: err.message, details: err.response?.data });
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

        const settingsCache = {};
        const getSettings = async (ownerId) => {
            if (settingsCache[ownerId]) return settingsCache[ownerId];
            const doc = await db.collection('settings').doc(ownerId).get();
            const data = doc.exists ? doc.data() : {};
            settingsCache[ownerId] = data;
            return data;
        };

        for (const doc of snapshot.docs) {
            const data = doc.data();
            const ownerId = data.ownerId;
            if (!ownerId) continue;

            const mpPaymentId = data.mpPaymentId;
            if (mpPaymentId && mpPaymentId !== 'null') {
                try {
                    const settings = await getSettings(ownerId);
                    const mpToken = settings?.mpAccessToken;
                    if (mpToken) {
                        const statusRes = await axios.get(
                            `https://api.mercadopago.com/v1/payments/${mpPaymentId}`,
                            { headers: { Authorization: `Bearer ${mpToken}` } }
                        );
                        if (statusRes.data.status === 'approved') {
                            const hoje = new Date().toISOString();
                            await doc.ref.update({
                                pago: true, status: 'pago',
                                paymentDate: hoje, paymentMethod: 'PIX',
                                dataPagamento: hoje, meioPagamento: 'PIX (automático)'
                            });
                            const mensagemPush = `Parcela ${data.number}/${data.total} de ${data.clientName} — R$ ${parseFloat(data.amount).toFixed(2).replace('.', ',')} pago via PIX`;
                            await db.collection('notificacoes').add({
                                ownerId, titulo: 'Pagamento Recebido!',
                                mensagem: mensagemPush,
                                lida: false, timestamp: new Date()
                            });
                            await enviarPushNotification(ownerId, '💰 Pagamento Recebido!', mensagemPush);
                            baixasFeitas++;
                            console.log(`✅ Baixa MP: parcela ${doc.id} (paymentId: ${mpPaymentId})`);
                            continue;
                        }
                    }
                } catch (e) { /* segue para verificar Asaas */ }
            }

            const asaasPaymentId = data.asaasPaymentId;
            if (asaasPaymentId && asaasPaymentId !== 'null') {
                try {
                    const settings = await getSettings(ownerId);
                    const asaasToken = settings?.asaasToken;
                    if (!asaasToken) continue;
                    const asaasAmbiente = settings?.asaasAmbiente || 'sandbox';
                    const base = asaasAmbiente === 'producao'
                        ? 'https://api.asaas.com/v3'
                        : 'https://sandbox.asaas.com/api/v3';
                    const statusRes = await axios.get(
                        `${base}/payments/${asaasPaymentId}`,
                        { headers: { 'access_token': asaasToken } }
                    );
                    const pagamento = statusRes.data;
                    const statusPago = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(pagamento.status);
                    if (!statusPago) continue;
                    const forma = pagamento.billingType === 'BOLETO'
                        ? 'Boleto (automático)'
                        : 'PIX (automático)';
                    const hoje = new Date().toISOString();
                    await doc.ref.update({
                        pago: true, status: 'pago',
                        paymentDate: hoje,
                        paymentMethod: pagamento.billingType === 'BOLETO' ? 'BOLETO' : 'PIX',
                        dataPagamento: hoje,
                        meioPagamento: forma
                    });
                    const mensagemPush = `Parcela ${data.number}/${data.total} de ${data.clientName} — R$ ${parseFloat(data.amount).toFixed(2).replace('.', ',')} ${forma}`;
                    await db.collection('notificacoes').add({
                        ownerId, titulo: 'Pagamento Recebido!',
                        mensagem: mensagemPush,
                        lida: false, timestamp: new Date()
                    });
                    await enviarPushNotification(ownerId, '💰 Pagamento Recebido!', mensagemPush);
                    baixasFeitas++;
                    console.log(`✅ Baixa Asaas: parcela ${doc.id} (${forma}, paymentId: ${asaasPaymentId})`);
                } catch (e) {
                    console.warn(`⚠️ Erro ao verificar Asaas para parcela ${doc.id}:`, e.response?.data || e.message);
                }
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
// ROTA 12 — Push manual (baixa manual no frontend)
// ============================================================
app.post('/enviar-push', async (req, res) => {
    res.sendStatus(200);
    try {
        const { ownerId, titulo, mensagem } = req.body;
        if (!ownerId || !titulo) return;
        await enviarPushNotification(ownerId, titulo, mensagem || '');
    } catch(err) {
        console.error('Erro /enviar-push:', err.message);
    }
});
// ============================================================
// ROTAS CRA21 — Cartório de Protesto
// Base URL: https://craam.api.crabr.com.br
// Autenticação: Basic Auth (usuário:senha do site CRA21)
// ============================================================
// ── Endpoints CRA21 por estado (padrão: cra{uf}.api.crabr.com.br)
//    AM confirmado em produção. Outros estados seguem o mesmo padrão do portal crabr.com.br.
//    Se um estado não estiver aqui ou o endpoint estiver errado, o usuário pode informar
//    a URL manualmente no campo "URL CRA21" nas configurações.
const CRA21_ENDPOINTS = {
    AC: 'https://craac.api.crabr.com.br',
    AL: 'https://craal.api.crabr.com.br',
    AM: 'https://craam.api.crabr.com.br',  // ← confirmado
    AP: 'https://craap.api.crabr.com.br',
    BA: 'https://craba.api.crabr.com.br',
    CE: 'https://crace.api.crabr.com.br',
    DF: 'https://cradf.api.crabr.com.br',
    ES: 'https://craes.api.crabr.com.br',
    GO: 'https://crago.api.crabr.com.br',
    MA: 'https://crama.api.crabr.com.br',
    MG: 'https://cramg.api.crabr.com.br',
    MS: 'https://crams.api.crabr.com.br',
    MT: 'https://cramt.api.crabr.com.br',
    PA: 'https://crapa.api.crabr.com.br',
    PB: 'https://crapb.api.crabr.com.br',
    PE: 'https://crape.api.crabr.com.br',
    PI: 'https://crapi.api.crabr.com.br',
    PR: 'https://crapr.api.crabr.com.br',
    RJ: 'https://crarj.api.crabr.com.br',
    RN: 'https://crarn.api.crabr.com.br',
    RO: 'https://craro.api.crabr.com.br',
    RR: 'https://crarr.api.crabr.com.br',
    RS: 'https://crars.api.crabr.com.br',
    SC: 'https://crasc.api.crabr.com.br',
    SE: 'https://crase.api.crabr.com.br',
    SP: 'https://crasp.api.crabr.com.br',
    TO: 'https://crato.api.crabr.com.br',
};

async function getCra21Creds(ownerId) {
    const snap = await db.collection('ownerConfigs').doc(ownerId).get();
    if (!snap.exists) throw new Error('ownerConfigs não encontrado para ' + ownerId);
    const d = snap.data();
    if (!d.cra21 || !d.cra21.usuario || !d.cra21.senha)
        throw new Error('Credenciais CRA21 não configuradas. Configure em Protesto → ⚙️ Configurar CRA21.');
    // Estado: raiz > dentro de cra21 > padrão AM
    const estado = d.estado || d.cra21.estado || 'AM';
    // URL: campo manual tem prioridade, depois lookup automático pelo estado
    const urlManual = d.cra21UrlOverride || d.cra21.urlOverride || '';
    const baseUrl   = urlManual || CRA21_ENDPOINTS[estado] || CRA21_ENDPOINTS['AM'];
    return {
        ...d.cra21,
        codApres:   d.cra21.codApres   || d.codApres   || '',
        idCartorio: d.cra21.idCartorio || d.idCartorio || '',
        comarca:    d.cra21.comarca    || d.comarca    || '',
        estado,
        baseUrl,
    };
}

function basicAuth(usuario, senha) {
    return 'Basic ' + Buffer.from(`${usuario}:${senha}`).toString('base64');
}

// ROTA 13 — Testar credenciais CRA21
app.post('/cra21/testar', async (req, res) => {
    const { ownerId } = req.body;
    if (!ownerId) return res.json({ ok: false, erro: 'ownerId obrigatório' });
    try {
        const creds = await getCra21Creds(ownerId);
        console.log(`[CRA21] Testando credenciais — estado: ${creds.estado} | endpoint: ${creds.baseUrl}`);
        const r = await axios.get(`${creds.baseUrl}/titulo`, {
            headers: { Authorization: basicAuth(creds.usuario, creds.senha) },
            validateStatus: () => true
        });
        if (r.status === 401) return res.json({ ok: false, erro: 'Usuário ou senha incorretos.' });
        if (r.status === 403) return res.json({ ok: false, erro: 'Acesso negado pelo CRA21.' });
        console.log(`[CRA21] Teste de credenciais OK para ${ownerId}, status ${r.status}`);
        res.json({ ok: true, status: r.status });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

// ROTA 14 — Consultar títulos protestados no CRA21
app.post('/cra21/consultar', async (req, res) => {
    const { ownerId, codApres: codApresOverride, idCartorio: idCartorioOverride, situacao: situacaoFiltro } = req.body;
    if (!ownerId) return res.json({ ok: false, erro: 'ownerId obrigatório' });
    try {
        const creds = await getCra21Creds(ownerId);
        const codApres   = codApresOverride   || creds.codApres;
        const idCartorio = idCartorioOverride || creds.idCartorio;
        // Monta parâmetros para /titulo
        const params = new URLSearchParams();
        if (idCartorio)    params.set('idCartorio', idCartorio);
        if (codApres)      params.set('idApresentante', codApres);
        // O CRA21 usa "situacao" para status do título e "ocorrencia" para coluna "Ocorrência"
        // Exemplos: PROTESTADO, RETORNADO, DEVOLVIDO, PAGO, PROTESTO CANCELADO
        if (situacaoFiltro) {
            params.set('situacao', situacaoFiltro);
            // Tenta também como ocorrencia (CRA21 coluna "Ocorrência")
            params.set('ocorrencia', situacaoFiltro);
        }
        const qs = params.toString();
        const url = `${creds.baseUrl}/titulo${qs ? '?' + qs : ''}`;
        console.log(`[CRA21] Consultando: ${url}`);
        const r = await axios.get(url, {
            headers: { Authorization: basicAuth(creds.usuario, creds.senha) },
            validateStatus: () => true
        });
        console.log(`[CRA21] Status: ${r.status} | Tipo: ${typeof r.data} | Chaves: ${r.data ? Object.keys(r.data).join(',') : 'null'}`);
        const data = r.data;
        // A API CRA21 retorna formato HAL: { _embedded: { titulo: [...] }, total_items: N }
        const titulos = Array.isArray(data) ? data :
                        Array.isArray(data?._embedded?.titulo) ? data._embedded.titulo :
                        Array.isArray(data?.titulos) ? data.titulos :
                        Array.isArray(data?.data) ? data.data : [];
        const total = data?.total_items ?? titulos.length;
        console.log(`[CRA21] Consulta retornou ${total} título(s) para ${ownerId} (codApres=${codApres||'não informado'})`);
        if (titulos.length > 0) {
            console.log(`[CRA21] Campos do 1º título: ${Object.keys(titulos[0]).join(', ')}`);
            console.log(`[CRA21] 1º título (raw):`, JSON.stringify(titulos[0]));
        }
        res.json({ ok: true, total, titulos, _raw: data, _status: r.status });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

// ROTA 14b — Listar cartórios disponíveis no CRA21 (diagnóstico)
app.post('/cra21/cartorios', async (req, res) => {
    const { ownerId } = req.body;
    if (!ownerId) return res.json({ ok: false, erro: 'ownerId obrigatório' });
    try {
        const creds = await getCra21Creds(ownerId);
        const r = await axios.get(`${creds.baseUrl}/cartorio`, {
            headers: { Authorization: basicAuth(creds.usuario, creds.senha) },
            validateStatus: () => true
        });
        console.log(`[CRA21] /cartorio status: ${r.status} | chaves: ${r.data ? Object.keys(r.data).join(',') : 'null'}`);
        res.json({ ok: true, status: r.status, data: r.data });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

// ROTA 15 — Enviar remessa de protesto ao CRA21
app.post('/cra21/enviar-remessa', async (req, res) => {
    const { ownerId, titulos } = req.body;
    if (!ownerId || !Array.isArray(titulos) || !titulos.length)
        return res.json({ ok: false, erro: 'ownerId e titulos[] obrigatórios' });
    try {
        const creds = await getCra21Creds(ownerId);
        const codApres   = creds.codApres   || '';
        const idCartorio = creds.idCartorio || '';
        const params = new URLSearchParams();
        if (idCartorio) params.set('idCartorio', idCartorio);
        if (codApres)   params.set('idApresentante', codApres);
        const qs = params.toString();
        const payload = titulos.map(t => ({
            NOME_DEVEDOR:      t.nomeDevedor,
            CPF_CNPJ_DEVEDOR:  t.cpfCnpj,
            LOGRADOURO:        t.logradouro,
            NUMERO:            t.numero,
            COMPLEMENTO:       '',
            BAIRRO:            t.bairro,
            CEP:               t.cep,
            MUNICIPIO:         t.municipio,
            UF:                t.uf,
            NUMERO_TITULO:     t.numeroTitulo,
            ESPECIE:           t.especie,
            DATA_EMISSAO:      t.dataEmissao,
            DATA_VENCIMENTO:   t.dataVencimento,
            VALOR:             t.valor,
            SALDO:             t.valor,
            NOSSO_NUMERO:      t.numeroTitulo,
            COMARCA:           t.comarca,
            ID_APRESENTANTE:   codApres,
            ID_CARTORIO:       idCartorio
        }));
        const urlRemessa = `${creds.baseUrl}/titulo${qs ? '?' + qs : ''}`;
        console.log(`[CRA21] Enviando remessa: POST ${urlRemessa} | ${titulos.length} título(s)`);
        const r = await axios.post(urlRemessa, payload, {
            headers: { Authorization: basicAuth(creds.usuario, creds.senha), 'Content-Type': 'application/json' },
            validateStatus: () => true
        });
        console.log(`[CRA21] Remessa status: ${r.status} | resp:`, JSON.stringify(r.data).slice(0,300));
        if (r.status >= 400) return res.json({ ok: false, erro: `CRA21 retornou ${r.status}`, data: r.data });
        console.log(`[CRA21] Remessa enviada: ${titulos.length} título(s) para ${ownerId}`);
        res.json({ ok: true, data: r.data });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

// ROTA 16 — Solicitar cancelamento de protesto no CRA21
app.post('/cra21/cancelar', async (req, res) => {
    const { ownerId, titulos } = req.body;
    if (!ownerId || !Array.isArray(titulos) || !titulos.length)
        return res.json({ ok: false, erro: 'ownerId e titulos[] obrigatórios' });
    try {
        const creds = await getCra21Creds(ownerId);
        const payload = titulos.map(t => ({
            NUMERO_TITULO: t.numeroTitulo,
            COMARCA:       t.comarca
        }));
        const r = await axios.post(`${creds.baseUrl}/cancelamento`, payload, {
            headers: { Authorization: basicAuth(creds.usuario, creds.senha), 'Content-Type': 'application/json' },
            validateStatus: () => true
        });
        if (r.status >= 400) return res.json({ ok: false, erro: `CRA21 retornou ${r.status}`, data: r.data });
        console.log(`[CRA21] Cancelamento enviado: ${titulos.length} título(s) para ${ownerId}`);
        res.json({ ok: true, data: r.data });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});
// ============================================================
// ROTA 17 — Upload de remessa direto ao portal web CRA21
// ============================================================

// Helper: extrai PHPSESSID dos headers set-cookie
function extractPhpsessid(headers) {
    for (const c of (headers['set-cookie'] || [])) {
        const m = c.match(/PHPSESSID=([^;]+)/i);
        if (m) return m[1];
    }
    return '';
}

// Helper: extrai acao (mantém URL-encoded para uso direto em URL)
function extractAcaoRaw(str) {
    // Da URL/Location: ?acao=XXX (captura com % para URL-encoded)
    const mUrl = str.match(/[?&]acao=([\w+/%=]+)/);
    if (mUrl) return mUrl[1];
    // Do HTML: action="...?acao=XXX"
    const mAct = str.match(/action="[^"]*[?&]acao=([\w+/%=]+)"/i);
    if (mAct) return mAct[1];
    // Do HTML: input name="acao" value="XXX"
    const mInp = str.match(/<input[^>]*name="acao"[^>]*value="([\w+/%=]+)"/i)
              || str.match(/<input[^>]*value="([\w+/%=]+)"[^>]*name="acao"/i);
    if (mInp) return mInp[1];
    return '';
}

// Helper: torna URL relativa em absoluta
function toAbsolute(url, domain, portalBase) {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    if (url.startsWith('/')) return `${domain}${url}`;
    return `${portalBase}/${url}`;
}

// Helper: login automático no portal CRA21 e retorna PHPSESSID
async function cra21PortalLogin(usuario, senha, estado) {
    const uf = (estado || 'AM').toLowerCase();
    const domain = `https://cra${uf}.crabr.com.br`;
    const portalBase = `${domain}/cra${uf}/site`;
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    let phpsessid = '';
    let loginAcao = '';

    // Passo 1: Tenta capturar o redirect (com maxRedirects:0)
    // Alguns ambientes lançam erro ao receber redirect com maxRedirects:0,
    // por isso usamos try/catch e verificamos tanto o response quanto o error.response
    try {
        const rootR = await axios.get(`${portalBase}/`, {
            headers: { 'User-Agent': userAgent, 'Cookie': 'aceito-cookie=yes' },
            validateStatus: () => true,
            maxRedirects: 0
        });
        const sess = extractPhpsessid(rootR.headers);
        if (sess) phpsessid = sess;
        const loc = rootR.headers['location'] || rootR.headers['Location'] || '';
        console.log(`[CRA21 Portal] root: status=${rootR.status} location="${loc.slice(0,120)}"`);
        if (loc) loginAcao = extractAcaoRaw(loc);
    } catch (err) {
        // axios pode lançar erro de redirect mesmo com validateStatus
        const resp = err.response;
        if (resp) {
            const sess = extractPhpsessid(resp.headers);
            if (sess) phpsessid = sess;
            const loc = resp.headers['location'] || resp.headers['Location'] || '';
            console.log(`[CRA21 Portal] root(catch): status=${resp.status} location="${loc.slice(0,120)}"`);
            if (loc) loginAcao = extractAcaoRaw(loc);
        } else {
            console.log(`[CRA21 Portal] root error: ${err.message}`);
        }
    }

    // Passo 2: Se não achou o acao no redirect, segue os redirects e lê o HTML
    if (!loginAcao) {
        console.log('[CRA21 Portal] acao não encontrado no redirect, tentando via HTML...');
        const pageR = await axios.get(`${portalBase}/`, {
            headers: { 'User-Agent': userAgent, 'Cookie': `aceito-cookie=yes${phpsessid ? '; PHPSESSID=' + phpsessid : ''}` },
            validateStatus: () => true,
            maxRedirects: 5
        });
        const sess = extractPhpsessid(pageR.headers);
        if (sess) phpsessid = sess;

        // Tenta pegar acao do path final (após redirects)
        const finalPath = pageR.request?.path || pageR.request?.res?.responseUrl || '';
        if (finalPath) loginAcao = extractAcaoRaw(finalPath);

        const html = String(pageR.data);
        console.log(`[CRA21 Portal] page html[0..500]: ${html.slice(0, 500)}`);

        if (!loginAcao) loginAcao = extractAcaoRaw(html);

        if (!loginAcao) {
            if (html.includes('menuApresentante') || html.includes('Upload remessa') || html.includes('CraMenu')) {
                console.log('[CRA21 Portal] Já autenticado (sem redirect)');
                return { phpsessid, portalBase };
            }
            throw new Error(`Portal CRA21: formulário de login não encontrado. HTML inicial: ${html.slice(0, 300)}`);
        }
    }

    console.log(`[CRA21 Portal] loginAcao: ${loginAcao.slice(0, 40)}... | PHPSESSID: ${phpsessid.slice(0, 8)}...`);

    // Passo 3: GET da página de login (com o acao) para obter sessão atualizada + nomes dos campos
    const loginUrl = `${portalBase}/admin.php?acao=${loginAcao}`;
    const loginPageR = await axios.get(loginUrl, {
        headers: { 'User-Agent': userAgent, 'Cookie': `aceito-cookie=yes${phpsessid ? '; PHPSESSID=' + phpsessid : ''}` },
        validateStatus: () => true,
        maxRedirects: 3
    });
    const sess2 = extractPhpsessid(loginPageR.headers);
    if (sess2) phpsessid = sess2;
    const loginPageHtml = String(loginPageR.data);

    const userField = (loginPageHtml.match(/<input[^>]*type="text"[^>]*name="([^"]+)"/i) || [])[1] || 'usuario';
    const passField = (loginPageHtml.match(/<input[^>]*type="password"[^>]*name="([^"]+)"/i) || [])[1] || 'senha';
    console.log(`[CRA21 Portal] campos form: user="${userField}" pass="${passField}"`);

    // Passo 4: POST com credenciais
    const form = new URLSearchParams();
    form.append('NTISPOSTBACK', '1');
    form.append('NTSUPERIORREF', `${portalBase}/`);
    form.append(userField, usuario);
    form.append(passField, senha);

    const loginR = await axios.post(loginUrl, form.toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': `aceito-cookie=yes; PHPSESSID=${phpsessid}`,
            'User-Agent': userAgent,
            'Referer': loginUrl
        },
        validateStatus: () => true,
        maxRedirects: 5
    });

    const sess3 = extractPhpsessid(loginR.headers);
    if (sess3) phpsessid = sess3;

    const loginHtml = String(loginR.data);
    if (loginHtml.toLowerCase().includes('type="password"') && !loginHtml.includes('menuApresentante')) {
        throw new Error('Usuário ou senha incorretos no portal CRA21.');
    }

    console.log(`[CRA21 Portal] Login OK | PHPSESSID: ${phpsessid.slice(0, 8)}...`);
    return { phpsessid, portalBase };
}

app.post('/cra21/upload-portal', async (req, res) => {
    const { ownerId, arquivoBase64, nomeArquivo } = req.body;
    if (!ownerId || !arquivoBase64)
        return res.json({ ok: false, erro: 'ownerId e arquivoBase64 obrigatórios' });

    try {
        const creds = await getCra21Creds(ownerId);
        const estado = creds.estado || 'AM';
        const uf = estado.toLowerCase();
        const portalBase = `https://cra${uf}.crabr.com.br/cra${uf}/site`;
        const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

        // acao da página de upload de remessa (PHP serializado em base64 — estático por portal)
        const UPLOAD_ACAO = creds.uploadAcao ||
            'NDQ5NTI5MEJPOjEwOiJTaXMyMV9BY2FvIjo5OntzOjE1OiIAKgBwcm9wcmllZGFkZXMiO086MTA6IkxpYjIxQXJyYXkiOjE6e3M6MTc6IgBMaWIyMUFycmF5AGFycmF5IjthOjM6e3M6MTQ6ImNsYXNzZUNvbnRyb2xlIjtzOjI4OiJDcmFBcHJlc2VudGFudGVVcGxvYWRSZW1lc3NhIjtzOjk6ImNsYXNzZVBhaSI7czoyNjoiQ3JhTWVudUFwcmVzZW50YW50ZVJlbWVzc2EiO3M6MTA6InRpcG9GdW5jYW8iO2k6Mjt9fXM6OToiACoAY29kaWdvIjtOO3M6MTA6IgAqAGFjYW9QYWkiO047czoxMToiACoAbWVuc2FnZW0iO047czoxNToiACoAbWVuc2FnZW1FcnJvIjtOO3M6MTU6IgAqAG1lbnNhZ2VtSW5mbyI7TjtzOjk6IgAqAHRpdHVsbyI7czoxNDoiVXBsb2FkIHJlbWVzc2EiO3M6MjQ6IgAqAGNhbWluaG9SZWxhdGl2b0ltYWdlbSI7TjtzOjE1OiIAKgBhY2Vzc29OZWdhZG8iO2I6MDt9';

        // Tenta sessão armazenada; se expirada, faz login
        let phpsessid = creds.phpsessid || '';
        let needsLogin = !phpsessid;

        const uploadUrl = `${portalBase}/admin.php?acao=${UPLOAD_ACAO}`;

        // Testa sessão: verifica se a página de upload está acessível (título correto)
        if (phpsessid) {
            const testR = await axios.get(uploadUrl, {
                headers: { 'Cookie': `aceito-cookie=yes; PHPSESSID=${phpsessid}`, 'User-Agent': userAgent },
                validateStatus: () => true, maxRedirects: 3
            });
            const testHtml = String(testR.data);
            // Sessão é VÁLIDA se a página de upload for retornada (título contém "Upload remessa")
            // INVÁLIDA se o título for só "CRA" ou vier redirect
            const isUploadPage = testHtml.includes('Upload remessa') || testHtml.includes('enviarRemessa');
            needsLogin = !isUploadPage;
            console.log(`[CRA21 Portal] Teste sessão: ${isUploadPage ? 'válida' : 'expirada'}`);
        }

        if (needsLogin) {
            console.log(`[CRA21 Portal] Sessão inválida — fazendo login automático...`);
            const result = await cra21PortalLogin(creds.usuario, creds.senha, estado);
            phpsessid = result.phpsessid;
            await db.collection('settings').doc(ownerId).update({ 'cra21.phpsessid': phpsessid });
        }

        // GET da página de upload para capturar campos e analisar formulário
        const uploadPageR = await axios.get(uploadUrl, {
            headers: { 'Cookie': `aceito-cookie=yes; PHPSESSID=${phpsessid}`, 'User-Agent': userAgent },
            validateStatus: () => true, maxRedirects: 3
        });
        const uploadPageHtml = String(uploadPageR.data);

        // Loga o bloco do formulário para diagnóstico
        const formMatch = uploadPageHtml.match(/<form[\s\S]{0,10000}?<\/form>/i);
        console.log(`[CRA21 Portal] Form HTML: ${formMatch ? formMatch[0].slice(0,2000) : '(form não encontrado)'}`);

        // Loga todos os inputs/selects do form para diagnóstico
        const allInputsRe = /<(?:input|select|textarea)[^>]*>/gi;
        const allInputs = uploadPageHtml.match(allInputsRe) || [];
        console.log(`[CRA21 Portal] Form inputs da página de upload: ${JSON.stringify(allInputs)}`);

        // Campos que NÃO devemos duplicar (já adicionamos manualmente com valores corretos)
        const skipFields = new Set(['NTISPOSTBACK', 'NTSUPERIORREF', 'acao', 'PHPSESSID']);

        // Extrai campos hidden da página (exceto os já gerenciados)
        const hiddenFields = [];
        const hiddenRe = /<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/gi;
        let hm;
        while ((hm = hiddenRe.exec(uploadPageHtml)) !== null) {
            const n = hm[1], v = hm[2];
            if (!skipFields.has(n)) hiddenFields.push({ n, v });
        }
        const hiddenRe2 = /<input[^>]*type="hidden"[^>]*value="([^"]*)"[^>]*name="([^"]+)"[^>]*>/gi;
        const found = new Set(hiddenFields.map(h => h.n));
        while ((hm = hiddenRe2.exec(uploadPageHtml)) !== null) {
            const n = hm[2], v = hm[1];
            if (!skipFields.has(n) && !found.has(n)) hiddenFields.push({ n, v });
        }

        // Extrai selects com valor selecionado (campos obrigatórios tipo "tipo de remessa")
        const selectRe = /<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi;
        const selectFields = [];
        let sm;
        while ((sm = selectRe.exec(uploadPageHtml)) !== null) {
            const selName = sm[1];
            if (skipFields.has(selName)) continue;
            // Pega option com selected, ou o primeiro option com valor
            const selOpt = sm[2].match(/<option[^>]*selected[^>]*value="([^"]*)"/i)
                        || sm[2].match(/<option[^>]*value="([^"]+)"/i);
            selectFields.push({ n: selName, v: selOpt ? selOpt[1] : '' });
        }

        // Nome do campo file e valor do botão submit
        const fileFieldM = uploadPageHtml.match(/<input[^>]*type="file"[^>]*name="([^"]+)"/i)
                        || uploadPageHtml.match(/<input[^>]*name="([^"]+)"[^>]*type="file"/i);
        const fileField = fileFieldM ? fileFieldM[1] : 'enviarRemessa';

        const submitM = uploadPageHtml.match(/<input[^>]*type="submit"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/i)
                     || uploadPageHtml.match(/<button[^>]*type="submit"[^>]*name="([^"]+)"[^>]*>([^<]+)<\/button>/i);
        const submitName  = submitM ? submitM[1] : 'enviar';
        const submitValue = submitM ? submitM[2].trim() : 'Enviar';

        console.log(`[CRA21 Portal] hidden: ${JSON.stringify(hiddenFields)} | selects: ${JSON.stringify(selectFields)} | fileField="${fileField}" | submit: ${submitName}="${submitValue}"`);

        // Monta multipart/form-data manualmente (sem dependência extra de npm)
        const fileBuffer = Buffer.from(arquivoBase64, 'base64');
        const nome = nomeArquivo || 'remessa.xlsx';
        const boundary = `----CraBoundary${Date.now()}`;

        const mkField = (name, value) => Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf-8');

        const parts = [
            mkField('NTISPOSTBACK', '1'),
            mkField('NTSUPERIORREF', uploadUrl),
        ];
        // Campos hidden da página (sem duplicar os já adicionados)
        for (const h of hiddenFields) parts.push(mkField(h.n, h.v));
        // Campos select (com valor selecionado ou primeiro valor)
        for (const s of selectFields) parts.push(mkField(s.n, s.v));
        // Arquivo
        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${nome}"\r\n` +
            `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`, 'utf-8'));
        parts.push(fileBuffer);
        parts.push(Buffer.from('\r\n', 'utf-8'));
        // Botão submit com valor real
        parts.push(mkField(submitName, submitValue));
        parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'));

        const body = Buffer.concat(parts);

        console.log(`[CRA21 Portal] Enviando remessa "${nome}" | ${fileBuffer.length} bytes | PHPSESSID: ${phpsessid.slice(0,8)}...`);

        const uploadR = await axios.post(uploadUrl, body, {
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length,
                'Cookie': `aceito-cookie=yes; PHPSESSID=${phpsessid}`,
                'User-Agent': userAgent,
                'Referer': uploadUrl
            },
            validateStatus: () => true,
            maxRedirects: 5
        });

        const uploadRespHtml = String(uploadR.data);
        // Busca a mensagem de erro/validação especificamente
        const erroBruto = uploadRespHtml.match(/(?:alert|mensagem|msg|erro|required|obrigat|campo)[^<]{0,300}/gi) || [];
        console.log(`[CRA21 Portal] Upload status: ${uploadR.status} | erros encontrados: ${JSON.stringify(erroBruto.slice(0,5))}`);
        console.log(`[CRA21 Portal] Upload resp html[0..1000]: ${uploadRespHtml.slice(0,1000)}`);

        const htmlR = uploadRespHtml;

        // Sessão expirou durante upload? (verifica se a página de upload sumiu)
        const stillUploadPage = htmlR.includes('Upload remessa') || htmlR.includes('enviarRemessa');
        if (!stillUploadPage && (htmlR.includes('esqueceu a senha') || htmlR.includes('NTISPOSTBACK'))) {
            return res.json({ ok: false, erro: 'Sessão CRA21 expirou. Tente novamente.' });
        }
        if (uploadR.status >= 400) {
            return res.json({ ok: false, erro: `Portal CRA21 retornou status ${uploadR.status}` });
        }

        // Detecta mensagens de erro/sucesso no HTML retornado (múltiplos padrões do Sis21)
        const strip = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

        // Padrões de ERRO
        const erroPatterns = [
            /class="[^"]*(?:alert-danger|bg-danger|text-danger|mensagem-erro|msg-erro|erro)[^"]*"[^>]*>([\s\S]{1,400}?)<\/(?:div|p|span|td)>/i,
            /<(?:div|p|span)[^>]*id="[^"]*(?:erro|error|msg)[^"]*"[^>]*>([\s\S]{1,400}?)<\/(?:div|p|span)>/i,
            /Informar os campos[^<]{0,200}/i,
            /Erro[^<]{0,200}/i,
        ];
        // Padrões de SUCESSO
        const succPatterns = [
            /class="[^"]*(?:alert-success|bg-success|text-success|mensagem-sucesso|msg-sucesso|sucesso)[^"]*"[^>]*>([\s\S]{1,400}?)<\/(?:div|p|span|td)>/i,
            /(?:Remessa|arquivo|upload)[^<]{0,200}(?:sucesso|processad|enviad|import)/i,
        ];

        let erroMsg = '', succMsg = '';
        for (const p of erroPatterns) {
            const m = htmlR.match(p);
            if (m) { erroMsg = strip(m[1] || m[0]); break; }
        }
        for (const p of succPatterns) {
            const m = htmlR.match(p);
            if (m) { succMsg = strip(m[1] || m[0]); break; }
        }

        if (erroMsg && !succMsg) {
            return res.json({ ok: false, erro: erroMsg });
        }

        const msg = succMsg || (erroMsg ? '' : 'Remessa enviada ao portal CRA21 com sucesso.');
        return res.json({ ok: true, mensagem: msg });

    } catch (e) {
        console.error('[CRA21 Portal] Erro:', e.message);
        res.json({ ok: false, erro: e.message });
    }
});

// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
