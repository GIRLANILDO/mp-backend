const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

// TABELA DE PREÇOS NO SERVIDOR (não pode ser alterada pelo cliente)
const PRECOS = {
    30: 40,
    60: 75,
    90: 110
};

app.post('/criar-pagamento', async (req, res) => {
    try {
        const body = req.body;
        const dias = parseInt(body.metadata?.dias) || 30;

        // Preço vem do servidor, não do cliente
        const preco = PRECOS[dias];
        if (!preco) return res.status(400).json({ error: 'Plano inválido.' });

        const response = await axios.post(
            'https://api.mercadopago.com/v1/payments',
            {
                transaction_amount: preco,
                description: `Licença ${dias} dias`,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
