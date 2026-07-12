const express = require('express');

const app = express();
app.use(express.json());

app.post('/api/telegram', require('./api/telegram'));
app.post('/api/setup', require('./api/setup'));
app.get('/api/health', require('./api/health'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on port ${port}`));
