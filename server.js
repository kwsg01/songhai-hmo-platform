const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfmake');
const nodemailer = require('nodemailer');

const app = express();

// Session configuration (works for both local and production)
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
app.use(express.static('public'));

// Database connection (uses environment variables on Render)
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

// ============ ADMIN AUTHENTICATION MIDDLEWARE ============
function requireAuth(req, res, next) {
    if (!req.session.adminId) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
}

// ============ AUTHENTICATION APIS ============
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

// ============ EMAIL CONFIGURATION ============
let emailTransporter = null;

async function setupEmail() {
    try {
        const testEmailAccount = await nodemailer.createTestAccount();
        emailTransporter = nodemailer.createTransport({
            host: 'smtp.ethereal.email',
            port: 587,
            secure: false,
            auth: {
                user: testEmailAccount.user,
                pass: testEmailAccount.pass
            }
        });
        console.log('✅ Email service ready');
    } catch (error) {
        console.error('Email setup error:', error);
    }
}

async function sendClaimNotification(providerEmail, providerName, claimId, status, adminNotes, enrolleeName, amount) {
    if (!emailTransporter) return null;
    
    const statusColor = status === 'Approved' ? 'green' : 'red';
    const appUrl = process.env.APP_URL || 'http://localhost:8080';
    
    const mailOptions = {
        from: '"Songhai HMO" <notifications@songhaihmo.com>',
        to: providerEmail,
        subject: `Claim #${claimId} ${status} - Songhai HMO`,
        html: `<div style="font-family: Arial; padding: 20px;">
            <h2 style="color: #1a73e8;">Songhai Health Trust HMO</h2>
            <h3>Claim Status Update</h3>
            <p>Dear ${providerName},</p>
            <p>Your claim <strong>#${claimId}</strong> has been <strong style="color: ${statusColor};">${status}</strong>.</p>
            <div style="background: #f5f5f5; padding: 15px; margin: 15px 0;">
                <p><strong>Claim Details:</strong></p>
                <p>📋 Enrollee: ${enrolleeName}</p>
                <p>💰 Amount: ₦${parseInt(amount).toLocaleString()}</p>
                ${adminNotes ? `<p>📝 Notes: ${adminNotes}</p>` : ''}
            </div>
            <p><a href="${appUrl}/provider.html" style="background: #1a73e8; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Login to Portal</a></p>
        </div>`
    };
    
    try {
        const info = await emailTransporter.sendMail(mailOptions);
        return nodemailer.getTestMessageUrl(info);
    } catch (error) {
        return null;
    }
}

setupEmail();

// ============ ENROLLEES ============
app.get('/api/enrollees', requireAuth, (req, res) => {
    db.query('SELECT * FROM enrollees ORDER BY created_at DESC', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.post('/api/enrollees', requireAuth, (req, res) => {
    const { first_name, last_name, email, phone, phone_number, alternative_phone, plan_type } = req.body;
    const finalPhone = phone || phone_number;
    db.query('INSERT INTO enrollees (first_name, last_name, email, phone, phone_number, alternative_phone, plan_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [first_name, last_name, email, finalPhone, finalPhone, alternative_phone, plan_type],
        (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Enrollee added', id: result.insertId });
        });
});

// ============ CLAIMS ============
app.get('/api/claims', requireAuth, (req, res) => {
    db.query(`SELECT claims.*, CONCAT(enrollees.first_name, ' ', enrollees.last_name) as enrollee_name,
              enrollees.phone as enrollee_phone
              FROM claims 
              JOIN enrollees ON claims.enrollee_id = enrollees.id 
              ORDER BY claims.submitted_at DESC`, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/callcentre/pending-claims', requireAuth, (req, res) => {
    db.query(`SELECT claims.*, CONCAT(enrollees.first_name, ' ', enrollees.last_name) as enrollee_name,
              enrollees.phone as enrollee_phone, enrollees.alternative_phone,
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

app.put('/api/claims/:id', requireAuth, async (req, res) => {
    const { status, admin_notes } = req.body;
    const claimId = req.params.id;
    
    db.query(`SELECT claims.*, providers.email as provider_email, providers.provider_name as provider_name,
              CONCAT(enrollees.first_name, ' ', enrollees.last_name) as enrollee_name
              FROM claims 
              JOIN providers ON claims.provider_id = providers.id
              JOIN enrollees ON claims.enrollee_id = enrollees.id
              WHERE claims.id = ?`, [claimId], async (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const claim = results[0];
        
        db.query('UPDATE claims SET status = ?, admin_notes = ? WHERE id = ?',
            [status, admin_notes, claimId],
            async (updateErr) => {
                if (updateErr) return res.status(500).json({ error: updateErr.message });
                
                let emailPreviewUrl = null;
                if (claim && (status === 'Approved' || status === 'Rejected')) {
                    emailPreviewUrl = await sendClaimNotification(
                        claim.provider_email,
                        claim.provider_name,
                        claimId,
                        status,
                        admin_notes,
                        claim.enrollee_name,
                        claim.amount
                    );
                }
                
                res.json({ 
                    message: 'Claim updated', 
                    emailSent: !!emailPreviewUrl,
                    emailPreview: emailPreviewUrl 
                });
            });
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

// ============ CALL CENTRE AUTH ============
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

// ============ REPORTING & ANALYTICS ============
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
    db.query(`SELECT 
                DATE_FORMAT(submitted_at, '%Y-%m') as month, 
                COUNT(*) as count,
                SUM(amount) as total
              FROM claims 
              WHERE submitted_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
              GROUP BY DATE_FORMAT(submitted_at, '%Y-%m')
              ORDER BY month ASC`, 
    (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/charts/top-providers', requireAuth, (req, res) => {
    db.query(`SELECT 
                provider_name, 
                COUNT(*) as claim_count,
                SUM(amount) as total_amount
              FROM claims 
              GROUP BY provider_name 
              ORDER BY claim_count DESC 
              LIMIT 5`,
    (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/recent-claims', requireAuth, (req, res) => {
    db.query(`SELECT claims.*, CONCAT(enrollees.first_name, ' ', enrollees.last_name) as enrollee_name 
              FROM claims 
              JOIN enrollees ON claims.enrollee_id = enrollees.id 
              ORDER BY claims.submitted_at DESC 
              LIMIT 10`,
    (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ============ CUSTOM REPORT BUILDER ============
app.post('/api/reports/custom', requireAuth, (req, res) => {
    const { start_date, end_date, status, provider_id } = req.body;
    
    let query = `
        SELECT 
            claims.id,
            CONCAT(enrollees.first_name, ' ', enrollees.last_name) as enrollee_name,
            enrollees.email as enrollee_email,
            enrollees.phone as enrollee_phone,
            claims.provider_name,
            claims.service_description,
            claims.amount,
            claims.status,
            claims.admin_notes,
            DATE_FORMAT(claims.submitted_at, '%Y-%m-%d %H:%i') as submitted_date
        FROM claims
        JOIN enrollees ON claims.enrollee_id = enrollees.id
        WHERE 1=1
    `;
    
    const params = [];
    
    if (start_date && end_date) {
        query += ` AND DATE(claims.submitted_at) BETWEEN ? AND ?`;
        params.push(start_date, end_date);
    }
    
    if (status && status !== 'All') {
        query += ` AND claims.status = ?`;
        params.push(status);
    }
    
    if (provider_id && provider_id !== 'All') {
        query += ` AND claims.provider_id = ?`;
        params.push(provider_id);
    }
    
    query += ` ORDER BY claims.submitted_at DESC`;
    
    db.query(query, params, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const summary = {
            total_claims: results.length,
            total_amount: results.reduce((sum, c) => sum + parseFloat(c.amount), 0),
            approved_count: results.filter(c => c.status === 'Approved').length,
            approved_amount: results.filter(c => c.status === 'Approved').reduce((sum, c) => sum + parseFloat(c.amount), 0),
            rejected_count: results.filter(c => c.status === 'Rejected').length,
            pending_count: results.filter(c => c.status === 'Pending').length
        };
        
        res.json({ claims: results, summary });
    });
});

app.post('/api/reports/export-excel', requireAuth, async (req, res) => {
    const { start_date, end_date, status, provider_id } = req.body;
    
    let query = `
        SELECT 
            claims.id as 'Claim ID',
            CONCAT(enrollees.first_name, ' ', enrollees.last_name) as 'Enrollee Name',
            enrollees.email as 'Enrollee Email',
            enrollees.phone as 'Enrollee Phone',
            claims.provider_name as 'Provider',
            claims.service_description as 'Service Description',
            claims.amount as 'Amount (₦)',
            claims.status as 'Status',
            claims.admin_notes as 'Admin Notes',
            DATE_FORMAT(claims.submitted_at, '%Y-%m-%d %H:%i') as 'Submission Date'
        FROM claims
        JOIN enrollees ON claims.enrollee_id = enrollees.id
        WHERE 1=1
    `;
    
    const params = [];
    
    if (start_date && end_date) {
        query += ` AND DATE(claims.submitted_at) BETWEEN ? AND ?`;
        params.push(start_date, end_date);
    }
    
    if (status && status !== 'All') {
        query += ` AND claims.status = ?`;
        params.push(status);
    }
    
    if (provider_id && provider_id !== 'All') {
        query += ` AND claims.provider_id = ?`;
        params.push(provider_id);
    }
    
    query += ` ORDER BY claims.submitted_at DESC`;
    
    db.query(query, params, async (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Custom Report');
        
        worksheet.mergeCells('A1:J1');
        worksheet.getCell('A1').value = 'Songhai HMO - Claims Report';
        worksheet.getCell('A1').font = { size: 16, bold: true };
        
        worksheet.mergeCells('A2:J2');
        worksheet.getCell('A2').value = `Generated: ${new Date().toLocaleString()}`;
        
        const headers = Object.keys(results[0] || {});
        headers.forEach((header, idx) => {
            worksheet.getCell(4, idx + 1).value = header;
            worksheet.getCell(4, idx + 1).font = { bold: true };
            worksheet.getCell(4, idx + 1).fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF1a73e8' }
            };
        });
        
        results.forEach((row, rowIdx) => {
            Object.values(row).forEach((value, colIdx) => {
                worksheet.getCell(rowIdx + 5, colIdx + 1).value = value;
            });
        });
        
        worksheet.columns.forEach(column => { column.width = 20; });
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=custom-report.xlsx');
        
        await workbook.xlsx.write(res);
        res.end();
    });
});

// ============ EXPORT APIS ============
app.get('/api/export/excel', requireAuth, async (req, res) => {
    db.query(`SELECT 
                claims.id, 
                CONCAT(enrollees.first_name, ' ', enrollees.last_name) as enrollee,
                claims.provider_name,
                claims.service_description,
                claims.amount,
                claims.status,
                claims.submitted_at
              FROM claims 
              JOIN enrollees ON claims.enrollee_id = enrollees.id 
              ORDER BY claims.submitted_at DESC`, async (err, claims) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Claims Report');
        
        worksheet.columns = [
            { header: 'Claim ID', key: 'id', width: 10 },
            { header: 'Enrollee', key: 'enrollee', width: 20 },
            { header: 'Provider', key: 'provider_name', width: 25 },
            { header: 'Service', key: 'service_description', width: 40 },
            { header: 'Amount (₦)', key: 'amount', width: 15 },
            { header: 'Status', key: 'status', width: 12 },
            { header: 'Date', key: 'submitted_at', width: 15 }
        ];
        
        claims.forEach(claim => { worksheet.addRow(claim); });
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=claims-report.xlsx');
        
        await workbook.xlsx.write(res);
        res.end();
    });
});

app.get('/api/export/pdf', requireAuth, (req, res) => {
    db.query(`SELECT 
                claims.id, 
                CONCAT(enrollees.first_name, ' ', enrollees.last_name) as enrollee,
                claims.provider_name,
                claims.service_description,
                claims.amount,
                claims.status,
                DATE_FORMAT(claims.submitted_at, '%Y-%m-%d') as date
              FROM claims 
              JOIN enrollees ON claims.enrollee_id = enrollees.id 
              ORDER BY claims.submitted_at DESC`, (err, claims) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const docDefinition = {
            content: [
                { text: 'Songhai HMO - Claims Report', style: 'header' },
                { text: `Generated: ${new Date().toLocaleString()}`, style: 'subheader' },
                { text: '\n' },
                {
                    table: {
                        headerRows: 1,
                        widths: ['auto', 'auto', 'auto', '*', 'auto', 'auto'],
                        body: [
                            ['ID', 'Enrollee', 'Provider', 'Service', 'Amount (₦)', 'Status'],
                            ...claims.map(c => [c.id, c.enrollee, c.provider_name, c.service_description.substring(0, 50), c.amount, c.status])
                        ]
                    }
                }
            ],
            styles: {
                header: { fontSize: 18, bold: true, margin: [0, 0, 0, 10] },
                subheader: { fontSize: 12, margin: [0, 0, 0, 20] }
            }
        };
        
        const PDFPrinter = require('pdfmake');
        const fonts = { Roboto: { normal: 'https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.1.66/fonts/Roboto/Roboto-Regular.ttf' } };
        const printer = new PDFPrinter(fonts);
        const pdfDoc = printer.createPdfKitDocument(docDefinition);
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=claims-report.pdf');
        pdfDoc.pipe(res);
        pdfDoc.end();
    });
});

// Serve homepage as default
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/homepage.html');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));