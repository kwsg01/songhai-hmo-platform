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
    origin: process.env.CORS_ORIGIN || 'http://localhost:8080',
    credentials: true
}));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database connection
const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || 'U13ps1060@',
    database: process.env.DB_NAME || 'hmo_system',
    port: process.env.DB_PORT || 3306,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

db.connect((err) => {
    if (err) {
        console.error('Database error:', err);
        return;
    }
    console.log('✅ MySQL connected');
});

// Serve homepage
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'homepage.html'));
});

// ============ ADMIN AUTHENTICATION ============
function requireAuth(req, res, next) {
    if (!req.session.adminId) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
}

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM admin_users WHERE (username = ? OR email = ?) AND password = ?',
        [username, username, password],
        (err, results) => {
            if (err) return res.status(500).json({ error: err.message });
            if (results.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
            
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
        });
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
app.get('/api/enrollees', requireAuth, (req, res) => {
    db.query('SELECT * FROM enrollees ORDER BY created_at DESC', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.post('/api/enrollees', requireAuth, (req, res) => {
    const { first_name, last_name, email, phone, plan_type } = req.body;
    db.query('INSERT INTO enrollees (first_name, last_name, email, phone, plan_type) VALUES (?, ?, ?, ?, ?)',
        [first_name, last_name, email, phone, plan_type],
        (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Enrollee added', id: result.insertId });
        });
});

// ============ CLAIMS ============
app.get('/api/claims', requireAuth, (req, res) => {
    db.query(`SELECT claims.*, CONCAT(enrollees.first_name, ' ', enrollees.last_name) as enrollee_name
              FROM claims 
              JOIN enrollees ON claims.enrollee_id = enrollees.id 
              ORDER BY claims.submitted_at DESC`, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/callcentre/pending-claims', requireAuth, (req, res) => {
    db.query(`SELECT claims.*, CONCAT(enrollees.first_name, ' ', enrollees.last_name) as enrollee_name,
              enrollees.phone as enrollee_phone,
              providers.provider_name, providers.email as provider_email
              FROM claims 
              JOIN enrollees ON claims.enrollee_id = enrollees.id 
              JOIN providers ON claims.provider_id = providers.id
              WHERE claims.status = 'Pending'
              ORDER BY claims.submitted_at ASC`, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.post('/api/claims', requireAuth, (req, res) => {
    const { enrollee_id, provider_id, provider_name, service_description, amount } = req.body;
    db.query('INSERT INTO claims (enrollee_id, provider_id, provider_name, service_description, amount, status) VALUES (?, ?, ?, ?, ?, "Pending")',
        [enrollee_id, provider_id, provider_name, service_description, amount],
        (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Claim submitted', id: result.insertId });
        });
});

app.put('/api/claims/:id', requireAuth, (req, res) => {
    const { status, admin_notes } = req.body;
    db.query('UPDATE claims SET status = ?, admin_notes = ? WHERE id = ?',
        [status, admin_notes, req.params.id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Claim updated' });
        });
});

// ============ PROVIDERS ============
app.get('/api/providers', requireAuth, (req, res) => {
    db.query('SELECT id, provider_name, email FROM providers', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.post('/api/provider/login', (req, res) => {
    const { email, password } = req.body;
    db.query('SELECT * FROM providers WHERE email = ? AND password = ?',
        [email, password],
        (err, results) => {
            if (err) return res.status(500).json({ error: err.message });
            if (results.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
            res.json({
                id: results[0].id,
                provider_name: results[0].provider_name,
                email: results[0].email
            });
        });
});

app.get('/api/provider/:id/claims', (req, res) => {
    db.query(`SELECT claims.*, CONCAT(enrollees.first_name, ' ', enrollees.last_name) as enrollee_name 
              FROM claims 
              JOIN enrollees ON claims.enrollee_id = enrollees.id 
              WHERE claims.provider_id = ?
              ORDER BY claims.submitted_at DESC`,
        [req.params.id],
        (err, results) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(results);
        });
});

// ============ CALL CENTRE ============
app.post('/api/callcentre/login', (req, res) => {
    const { email, password } = req.body;
    db.query('SELECT * FROM call_centre_staff WHERE email = ? AND password = ?',
        [email, password],
        (err, results) => {
            if (err) return res.status(500).json({ error: err.message });
            if (results.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
            res.json({
                id: results[0].id,
                full_name: results[0].full_name,
                email: results[0].email,
                employee_id: results[0].employee_id
            });
        });
});

// ============ DASHBOARD ============
app.get('/api/dashboard/stats', requireAuth, (req, res) => {
    const queries = {
        totalEnrollees: 'SELECT COUNT(*) as count FROM enrollees',
        totalClaims: 'SELECT COUNT(*) as count FROM claims',
        totalPending: 'SELECT COUNT(*) as count FROM claims WHERE status = "Pending"',
        totalApproved: 'SELECT COUNT(*) as count FROM claims WHERE status = "Approved"',
        totalRejected: 'SELECT COUNT(*) as count FROM claims WHERE status = "Rejected"',
        totalAmount: 'SELECT SUM(amount) as total FROM claims WHERE status = "Approved"'
    };
    
    Promise.all(Object.values(queries).map(sql => 
        new Promise((resolve, reject) => {
            db.query(sql, (err, result) => {
                if (err) reject(err);
                else resolve(result[0]);
            });
        })
    )).then(results => {
        const keys = Object.keys(queries);
        const response = {};
        results.forEach((result, index) => {
            response[keys[index].replace('total', '').toLowerCase()] = Object.values(result)[0] || 0;
        });
        res.json(response);
    }).catch(err => res.status(500).json({ error: err.message }));
});

app.get('/api/charts/claims-by-status', requireAuth, (req, res) => {
    db.query('SELECT status, COUNT(*) as count FROM claims GROUP BY status', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/charts/monthly-trend', requireAuth, (req, res) => {
    db.query(`SELECT DATE_FORMAT(submitted_at, '%Y-%m') as month, COUNT(*) as count
              FROM claims WHERE submitted_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
              GROUP BY month ORDER BY month ASC`, 
    (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/charts/top-providers', requireAuth, (req, res) => {
    db.query(`SELECT provider_name, COUNT(*) as claim_count
              FROM claims GROUP BY provider_name ORDER BY claim_count DESC LIMIT 5`,
    (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/recent-claims', requireAuth, (req, res) => {
    db.query(`SELECT claims.*, CONCAT(enrollees.first_name, ' ', enrollees.last_name) as enrollee_name 
              FROM claims JOIN enrollees ON claims.enrollee_id = enrollees.id 
              ORDER BY claims.submitted_at DESC LIMIT 10`,
    (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
