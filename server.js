const express = require('express');
const mysql = require('mysql2');
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
        maxAge: 24 * 60 * 60 * 1000
    }
}));

app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true
}));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create database connection pool (better for cloud)
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'hmo_system',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    ...(process.env.DB_SSL === 'true' && { ssl: { rejectUnauthorized: false } })
});

// Test connection on startup
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
        console.error('Check your environment variables on Render');
        return;
    }
    console.log('✅ MySQL connected successfully');
    connection.release();
});

// Use promise wrapper
const db = pool.promise();

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
        const [results] = await db.query(
            'SELECT * FROM admin_users WHERE (username = ? OR email = ?) AND password = ?',
            [username, username, password]
        );
        
        if (results.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const admin = results[0];
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
        res.status(500).json({ error: 'Database error: ' + err.message });
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
        const [results] = await db.query('SELECT * FROM enrollees ORDER BY created_at DESC');
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/enrollees', requireAuth, async (req, res) => {
    const { first_name, last_name, email, phone, plan_type } = req.body;
    try {
        const [result] = await db.query(
            'INSERT INTO enrollees (first_name, last_name, email, phone, plan_type) VALUES (?, ?, ?, ?, ?)',
            [first_name, last_name, email, phone, plan_type]
        );
        res.json({ message: 'Enrollee added', id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ CLAIMS ============
app.get('/api/claims', requireAuth, async (req, res) => {
    try {
        const [results] = await db.query(`
            SELECT claims.*, CONCAT(enrollees.first_name, ' ', enrollees.last_name) as enrollee_name
            FROM claims 
            JOIN enrollees ON claims.enrollee_id = enrollees.id 
            ORDER BY claims.submitted_at DESC
        `);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/callcentre/pending-claims', requireAuth, async (req, res) => {
    try {
        const [results] = await db.query(`
            SELECT claims.*, CONCAT(enrollees.first_name, ' ', enrollees.last_name) as enrollee_name,
            enrollees.phone as enrollee_phone,
            providers.provider_name, providers.email as provider_email
            FROM claims 
            JOIN enrollees ON claims.enrollee_id = enrollees.id 
            JOIN providers ON claims.provider_id = providers.id
            WHERE claims.status = 'Pending'
            ORDER BY claims.submitted_at ASC
        `);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/claims', requireAuth, async (req, res) => {
    const { enrollee_id, provider_id, provider_name, service_description, amount } = req.body;
    try {
        const [result] = await db.query(
            'INSERT INTO claims (enrollee_id, provider_id, provider_name, service_description, amount, status) VALUES (?, ?, ?, ?, ?, "Pending")',
            [enrollee_id, provider_id, provider_name, service_description, amount]
        );
        res.json({ message: 'Claim submitted', id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/claims/:id', requireAuth, async (req, res) => {
    const { status, admin_notes } = req.body;
    try {
        await db.query(
            'UPDATE claims SET status = ?, admin_notes = ? WHERE id = ?',
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
        const [results] = await db.query('SELECT id, provider_name, email FROM providers');
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/provider/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [results] = await db.query(
            'SELECT * FROM providers WHERE email = ? AND password = ?',
            [email, password]
        );
        if (results.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        res.json({
            id: results[0].id,
            provider_name: results[0].provider_name,
            email: results[0].email
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/provider/:id/claims', async (req, res) => {
    try {
        const [results] = await db.query(`
            SELECT claims.*, CONCAT(enrollees.first_name, ' ', enrollees.last_name) as enrollee_name 
            FROM claims 
            JOIN enrollees ON claims.enrollee_id = enrollees.id 
            WHERE claims.provider_id = ?
            ORDER BY claims.submitted_at DESC
        `, [req.params.id]);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ CALL CENTRE ============
app.post('/api/callcentre/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [results] = await db.query(
            'SELECT * FROM call_centre_staff WHERE email = ? AND password = ?',
            [email, password]
        );
        if (results.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        res.json({
            id: results[0].id,
            full_name: results[0].full_name,
            email: results[0].email,
            employee_id: results[0].employee_id
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ DASHBOARD ============
app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
    try {
        const [enrollees] = await db.query('SELECT COUNT(*) as count FROM enrollees');
        const [claims] = await db.query('SELECT COUNT(*) as count FROM claims');
        const [pending] = await db.query('SELECT COUNT(*) as count FROM claims WHERE status = "Pending"');
        const [approved] = await db.query('SELECT COUNT(*) as count FROM claims WHERE status = "Approved"');
        const [rejected] = await db.query('SELECT COUNT(*) as count FROM claims WHERE status = "Rejected"');
        const [amount] = await db.query('SELECT SUM(amount) as total FROM claims WHERE status = "Approved"');
        
        res.json({
            enrollees: enrollees[0].count || 0,
            claims: claims[0].count || 0,
            pending: pending[0].count || 0,
            approved: approved[0].count || 0,
            rejected: rejected[0].count || 0,
            amount: amount[0].total || 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/charts/claims-by-status', requireAuth, async (req, res) => {
    try {
        const [results] = await db.query('SELECT status, COUNT(*) as count FROM claims GROUP BY status');
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/charts/monthly-trend', requireAuth, async (req, res) => {
    try {
        const [results] = await db.query(`
            SELECT DATE_FORMAT(submitted_at, '%Y-%m') as month, COUNT(*) as count
            FROM claims 
            WHERE submitted_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
            GROUP BY month ORDER BY month ASC
        `);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/charts/top-providers', requireAuth, async (req, res) => {
    try {
        const [results] = await db.query(`
            SELECT provider_name, COUNT(*) as claim_count
            FROM claims GROUP BY provider_name ORDER BY claim_count DESC LIMIT 5
        `);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/recent-claims', requireAuth, async (req, res) => {
    try {
        const [results] = await db.query(`
            SELECT claims.*, CONCAT(enrollees.first_name, ' ', enrollees.last_name) as enrollee_name 
            FROM claims 
            JOIN enrollees ON claims.enrollee_id = enrollees.id 
            ORDER BY claims.submitted_at DESC LIMIT 10
        `);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
