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
// Base URL: https://crama.api.crabr.com.br
// Autenticação: Basic Auth (usuário:senha do site CRA21)
// ============================================================
const CRA21_API = 'https://craam.api.crabr.com.br';

async function getCra21Creds(ownerId) {
    const snap = await db.collection('ownerConfigs').doc(ownerId).get();
    if (!snap.exists) throw new Error('ownerConfigs não encontrado para ' + ownerId);
    const d = snap.data();
    if (!d.cra21 || !d.cra21.usuario || !d.cra21.senha)
        throw new Error('Credenciais CRA21 não configuradas. Configure em Protesto → ⚙️ Configurar CRA21.');
    return d.cra21;
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
        const r = await axios.get(`${CRA21_API}/url/titulo`, {
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
    const { ownerId, idCartorio, dataInicial, dataFinal } = req.body;
    if (!ownerId) return res.json({ ok: false, erro: 'ownerId obrigatório' });
    try {
        const creds = await getCra21Creds(ownerId);
        // Monta parâmetros para /url/titulo
        // idCartorio 1301209 = 1º Ofício de Coari/AM
        const cartorio = idCartorio || creds.idCartorio || '1301209';
        const params = new URLSearchParams({ idCartorio: cartorio });
        // idApresentante filtra pelos títulos da empresa (codApres salvo nas credenciais)
        if (creds.codApres) params.set('idApresentante', creds.codApres);
        const url = `${CRA21_API}/url/titulo?${params.toString()}`;
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
        console.log(`[CRA21] Consulta retornou ${total} título(s) para ${ownerId}`);
        res.json({ ok: true, total, titulos, _raw: data, _status: r.status });
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
        const payload = titulos.map(t => ({
            NOME_DEVEDOR:     t.nomeDevedor,
            CPF_CNPJ_DEVEDOR: t.cpfCnpj,
            LOGRADOURO:       t.logradouro,
            NUMERO:           t.numero,
            COMPLEMENTO:      '',
            BAIRRO:           t.bairro,
            CEP:              t.cep,
            MUNICIPIO:        t.municipio,
            UF:               t.uf,
            NUMERO_TITULO:    t.numeroTitulo,
            ESPECIE:          t.especie,
            DATA_EMISSAO:     t.dataEmissao,
            DATA_VENCIMENTO:  t.dataVencimento,
            VALOR:            t.valor,
            SALDO:            t.valor,
            NOSSO_NUMERO:     t.numeroTitulo,
            COMARCA:          t.comarca
        }));
        const r = await axios.post(`${CRA21_API}/url/remessa`, payload, {
            headers: { Authorization: basicAuth(creds.usuario, creds.senha), 'Content-Type': 'application/json' },
            validateStatus: () => true
        });
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
        const r = await axios.post(`${CRA21_API}/url/cancelamento`, payload, {
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
