const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');

const app = express();

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'songhai-hmo-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    }
}));

app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true
}));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// PostgreSQL connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection error:', err.message);
        return;
    }
    console.log('✅ PostgreSQL connected successfully');
    release();
});

// Serve homepage
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'homepage.html'));
});

// ============ ADMIN AUTHENTICATION ============
async function requireAuth(req, res, next) {
    if (!req.session.adminId) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
}

app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query(
            'SELECT * FROM admin_users WHERE (username = $1 OR email = $1) AND password = $2',
            [username, password]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const admin = result.rows[0];
        req.session.adminId = admin.id;
        req.session.adminName = admin.full_name;
        req.session.adminRole = admin.role;
        req.session.username = admin.username;
        
        res.json({
            success: true,
            admin: {
                id: admin.id,
                username: admin.username,
                full_name: admin.full_name,
                role: admin.role
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/admin/check-session', (req, res) => {
    if (req.session.adminId) {
        res.json({ 
            authenticated: true, 
            admin: {
                username: req.session.username,
                full_name: req.session.adminName,
                role: req.session.adminRole
            }
        });
    } else {
        res.json({ authenticated: false });
    }
});

// ============ ENROLLEES ============
app.get('/api/enrollees', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM enrollees ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/enrollees', requireAuth, async (req, res) => {
    const { first_name, last_name, email, phone, plan_type } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO enrollees (first_name, last_name, email, phone, plan_type) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [first_name, last_name, email, phone, plan_type]
        );
        res.json({ message: 'Enrollee added', id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ CLAIMS ============
app.get('/api/claims', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.*, CONCAT(e.first_name, ' ', e.last_name) as enrollee_name
            FROM claims c
            JOIN enrollees e ON c.enrollee_id = e.id 
            ORDER BY c.submitted_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/callcentre/pending-claims', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.*, CONCAT(e.first_name, ' ', e.last_name) as enrollee_name,
            e.phone as enrollee_phone,
            p.provider_name, p.email as provider_email
            FROM claims c
            JOIN enrollees e ON c.enrollee_id = e.id 
            JOIN providers p ON c.provider_id = p.id
            WHERE c.status = 'Pending'
            ORDER BY c.submitted_at ASC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/claims', requireAuth, async (req, res) => {
    const { enrollee_id, provider_id, provider_name, service_description, amount } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO claims (enrollee_id, provider_id, provider_name, service_description, amount, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [enrollee_id, provider_id, provider_name, service_description, amount, 'Pending']
        );
        res.json({ message: 'Claim submitted', id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/claims/:id', requireAuth, async (req, res) => {
    const { status, admin_notes } = req.body;
    try {
        await pool.query(
            'UPDATE claims SET status = $1, admin_notes = $2 WHERE id = $3',
            [status, admin_notes, req.params.id]
        );
        res.json({ message: 'Claim updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ PROVIDERS ============
app.get('/api/providers', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, provider_name, email FROM providers');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/provider/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query(
            'SELECT * FROM providers WHERE email = $1 AND password = $2',
            [email, password]
        );
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        res.json({
            id: result.rows[0].id,
            provider_name: result.rows[0].provider_name,
            email: result.rows[0].email
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/provider/:id/claims', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.*, CONCAT(e.first_name, ' ', e.last_name) as enrollee_name 
            FROM claims c
            JOIN enrollees e ON c.enrollee_id = e.id 
            WHERE c.provider_id = $1
            ORDER BY c.submitted_at DESC
        `, [req.params.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ CALL CENTRE ============
app.post('/api/callcentre/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query(
            'SELECT * FROM call_centre_staff WHERE email = $1 AND password = $2',
            [email, password]
        );
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        res.json({
            id: result.rows[0].id,
            full_name: result.rows[0].full_name,
            email: result.rows[0].email,
            employee_id: result.rows[0].employee_id
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ DASHBOARD ============
app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
    try {
        const enrollees = await pool.query('SELECT COUNT(*) as count FROM enrollees');
        const claims = await pool.query('SELECT COUNT(*) as count FROM claims');
        const pending = await pool.query('SELECT COUNT(*) as count FROM claims WHERE status = $1', ['Pending']);
        const approved = await pool.query('SELECT COUNT(*) as count FROM claims WHERE status = $1', ['Approved']);
        const rejected = await pool.query('SELECT COUNT(*) as count FROM claims WHERE status = $1', ['Rejected']);
        const amount = await pool.query('SELECT SUM(amount) as total FROM claims WHERE status = $1', ['Approved']);
        
        res.json({
            enrollees: parseInt(enrollees.rows[0].count) || 0,
            claims: parseInt(claims.rows[0].count) || 0,
            pending: parseInt(pending.rows[0].count) || 0,
            approved: parseInt(approved.rows[0].count) || 0,
            rejected: parseInt(rejected.rows[0].count) || 0,
            amount: parseFloat(amount.rows[0].total) || 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/charts/claims-by-status', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT status, COUNT(*) as count FROM claims GROUP BY status');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/charts/monthly-trend', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT TO_CHAR(submitted_at, 'YYYY-MM') as month, COUNT(*) as count
            FROM claims 
            WHERE submitted_at >= NOW() - INTERVAL '6 months'
            GROUP BY month ORDER BY month ASC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/charts/top-providers', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT provider_name, COUNT(*) as claim_count
            FROM claims GROUP BY provider_name ORDER BY claim_count DESC LIMIT 5
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/recent-claims', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.*, CONCAT(e.first_name, ' ', e.last_name) as enrollee_name 
            FROM claims c
            JOIN enrollees e ON c.enrollee_id = e.id 
            ORDER BY c.submitted_at DESC LIMIT 10
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
