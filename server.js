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
        // 1. Obtém/cria cliente no Asaas
        const customerId = await obterOuCriarClienteAsaas(asaasApiKey, payerName, payerCpfCnpj, payerEmail);
        // 2. Cria cobrança PIX
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
        // 3. Busca QR Code
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
// URL: https://intuitive-surprise-production-8572.up.railway.app/webhook/asaas
// Eventos: PAYMENT_RECEIVED, PAYMENT_CONFIRMED
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
        // Tenta encontrar a parcela de duas formas:
        // 1) fluxo antigo: externalReference = installmentId (doc ID no Firebase)
        // 2) fluxo novo (carnê nativo): externalReference = saleId → busca por asaasPaymentId
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
        // Detecta se foi boleto ou PIX
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
        await db.collection('notificacoes').add({
            ownerId:   data.ownerId,
            titulo:    'Pagamento Recebido!',
            mensagem:  `Parcela ${data.number}/${data.total} de ${data.clientName} — R$ ${parseFloat(data.amount).toFixed(2).replace('.', ',')} pago via ${formaPagamento}`,
            lida:      false,
            timestamp: new Date()
        });
        console.log(`✅ Baixa automática Asaas: parcela ${installmentId} (${formaPagamento}, paymentId: ${payment.id})`);
    } catch (err) {
        console.error('Erro no webhook Asaas:', err.response?.data || err.message);
    }
});
// ============================================================
// ROTA 7 — Criar BOLETO BANCÁRIO de PARCELA (Asaas)
// Chamado pelo frontend quando metodoQrCode === 'asaas'
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

        // Base URL conforme ambiente escolhido nas configurações da ótica
        const base = asaasAmbiente === 'producao'
            ? 'https://api.asaas.com/v3'
            : 'https://sandbox.asaas.com/api/v3';

        const headers = { 'access_token': asaasToken, 'Content-Type': 'application/json' };

        // 1. Busca cliente pelo CPF, ou cria se não existir
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

        // 2. Cria boleto bancário
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
        console.log('[Asaas Boleto] bankSlipUrl:', pagamento.bankSlipUrl);

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
// ROTA 8 — Criar CARNÊ NATIVO no Asaas (parcelamento único, múltiplos boletos por folha)
// Chamado UMA VEZ por venda — Asaas agrupa e gera carnê PDF com 3 boletos por folha A4
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

        // 1. Busca ou cria cliente
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

        // 2. Cria parcelamento nativo — Asaas gera todos os boletos agrupados
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

        // 3. Busca todas as parcelas do grupo para obter IDs e URLs individuais
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

        // paymentBookUrl é servido via rota proxy GET /asaas/carne/:saleId
        // (o endpoint do Asaas retorna PDF binário, não URL — por isso usamos o proxy)
        res.json({ installmentId: installmentGroupId, payments });
    } catch (err) {
        console.error('[Asaas Carnê] Erro status:', err.response?.status);
        console.error('[Asaas Carnê] Erro data:', JSON.stringify(err.response?.data));
        res.status(500).json({ error: err.message, details: err.response?.data });
    }
});
// ============================================================
// ROTA 9 — Proxy: serve o PDF do carnê Asaas (3 boletos por folha A4)
// GET /asaas/carne/:saleId
// O Asaas retorna o carnê como PDF binário — esta rota faz o pipe direto para o navegador
// ============================================================
app.get('/asaas/carne/:saleId', async (req, res) => {
    try {
        const { saleId } = req.params;

        // Busca a venda para obter ownerId e asaasInstallmentId
        const saleDoc = await db.collection('sales').doc(saleId).get();
        if (!saleDoc.exists) return res.status(404).json({ error: 'Venda não encontrada' });
        const sale = saleDoc.data();
        const ownerId       = sale.ownerId || sale.userId;
        const installmentId = sale.asaasInstallmentId;
        if (!installmentId) return res.status(404).json({ error: 'Carnê Asaas não gerado para esta venda' });

        // Busca token e ambiente nas configurações da loja
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

        // Faz pipe do PDF binário retornado pelo Asaas diretamente para o navegador
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
// VERIFICAÇÃO AUTOMÁTICA — a cada 5 minutos confere parcelas pendentes
// Cobre tanto Mercado Pago (PIX) quanto Asaas (Boleto e PIX)
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

        // Cache de settings por ownerId para não buscar repetidamente
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

            // ── Verificação Mercado Pago ──────────────────────────
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
                            await db.collection('notificacoes').add({
                                ownerId, titulo: 'Pagamento Recebido!',
                                mensagem: `Parcela ${data.number}/${data.total} de ${data.clientName} — R$ ${parseFloat(data.amount).toFixed(2).replace('.', ',')} pago via PIX`,
                                lida: false, timestamp: new Date()
                            });
                            baixasFeitas++;
                            console.log(`✅ Baixa MP: parcela ${doc.id} (paymentId: ${mpPaymentId})`);
                            continue; // já deu baixa, pula para a próxima parcela
                        }
                    }
                } catch (e) { /* segue para verificar Asaas */ }
            }

            // ── Verificação Asaas (Boleto ou PIX) ────────────────
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
                    await db.collection('notificacoes').add({
                        ownerId, titulo: 'Pagamento Recebido!',
                        mensagem: `Parcela ${data.number}/${data.total} de ${data.clientName} — R$ ${parseFloat(data.amount).toFixed(2).replace('.', ',')} ${forma}`,
                        lida: false, timestamp: new Date()
                    });
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
