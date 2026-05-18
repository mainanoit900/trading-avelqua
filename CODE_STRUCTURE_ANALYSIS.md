# Trading Avelqua V3 - Code Structure Analysis

**วันที่วิเคราะห์**: 18 พฤษภาคม 2569  
**เวอร์ชัน**: 3.1.0  
**Entry Point**: `server.js`  
**Database**: PostgreSQL

---

## 📋 Project Overview

**Trading Avelqua** เป็น Platform สำหรับจัดการ MT5 Bot Trading และ VPS พร้อม Admin & Customer Portal  
สร้างด้วย Express.js + PostgreSQL + Socket.io

### 🎯 Core Functions
- **Admin Dashboard**: จัดการ Bots, VPS Ports, MT5 Presets
- **Customer Portal**: ซื้อ Package, ตั้งค่า Bot, ดูสถานะ Live Trading
- **VPS Agent**: ควบคุม VPS และ MT5 Terminal
- **Payment Gateway**: KBANK, Scoin Currency
- **Multi-language Support**: TH, EN, LO, VI, MY

---

## 🛠️ Technology Stack

### **Backend**
- **Framework**: Express.js 4.19.2
- **Runtime**: Node.js
- **Database**: PostgreSQL 8.20.0
- **Cache/Session**: Redis (ioredis 5.10.1)
- **Authentication**: Passport.js + Google OAuth 2.0
- **Rate Limiting**: express-rate-limit

### **Security**
- **Helmet.js**: HTTP Headers Protection
- **bcryptjs**: Password Hashing
- **dotenv**: Environment Management

### **Additional Libraries**
- **Socket.io**: Real-time Communication (4.8.3)
- **WebSocket (ws)**: Alternative Real-time (8.20.0)
- **Nodemailer**: Email Service (8.0.5)
- **Multer**: File Upload (2.1.1)
- **XLSX**: Excel Processing (0.18.5)
- **Axios**: HTTP Client (1.15.1)
- **UUID**: ID Generation (13.0.0)

### **Frontend**
- **Template Engine**: EJS
- **CSS**: Custom + Bootstrap
- **Localization**: i18n (Thai, English, Lao, Vietnamese, Myanmar)

---

## 🏗️ Architecture Layers

### **Application Structure**
```
trading-avelqua/
├── server.js                 # Main Entry Point
├── config/                   # Configuration Files
│   ├── database.js          # PostgreSQL Connection Pool
│   └── db.js                # Alternative DB Config
├── middleware/              # Express Middleware
│   ├── admin.js            # Admin Authentication
│   ├── auth.js             # General Auth
│   ├── requireAuth.js      # Auth Verification
│   └── requireVerified.js  # Email Verification Check
├── routes/                  # API & Web Routes
├── services/               # Business Logic
├── repositories/           # Database Access Layer
├── lib/                   # Utility Libraries
├── views/                 # EJS Templates
├── public/               # Static Assets (CSS, JS, Images)
├── db/                   # Database Schemas & Migrations
└── scripts/              # Utility Scripts
```

---

## 🔀 Routes Architecture

### **Main Routes** (in order of execution)

| Route | Purpose | Auth | Priority |
|-------|---------|------|----------|
| `/auth` | Login, Register, Google OAuth | No | High |
| `/admin/*` | Admin Dashboard | Admin | High |
| `/app/*` | Customer Portal | User | High |
| `/api/vps-agent` | Production VPS API | Token | High |
| `/api/vps-agent-legacy` | Legacy VPS API | Token | Medium |
| `/api/*` | General API | Varies | Medium |
| `/` (web) | Public Pages | No | Medium |
| `/cart` | Shopping Cart | No | Low |
| `/payment` | Payment Processing | User | Low |

### **Route Files Details**

**Admin Routes** (require Admin Middleware):
- `admin.js` - Dashboard, User Management
- `admin-mt5-presets.js` - MT5 Bot Presets Configuration
- `admin-vps-control.js` - VPS Control Panel
- `admin-vps-port-actions.js` - Port Allocation & Release
- `admin-bot.js`, `admin-bots.js` - Bot Management
- `admin-bot-trading.js` - Trading Controls

**App Routes** (Customer Portal):
- `app.js` - Main Portal
- `app-mt5-bot.js` - Bot Setup & Management
- `app-mt5-connect-production.js` - MT5 Connection (Production)

**API Routes**:
- `api.js` - General API Endpoints
- `vps-agent-api-production.js` - Production VPS Agent
- `vps-agent-api.js` - Legacy VPS Agent
- `pro-vps-agent-api.js` - Professional VPS API
- `pro-mt5-core.js` - Professional MT5 Core

**Public Routes**:
- `web.js` - Public Pages (Home, About, etc.)
- `auth.js` - Authentication (Login, Register)
- `cart.js` - Shopping Cart
- `payment.js` - Payment Processing

---

## 🔧 Services (Business Logic)

### **Core Services**
| Service | Responsibility |
|---------|-----------------|
| `userService.js` | User Management & Profile |
| `vpsService.js` | VPS Management & Control |
| `vpsAgent.js` | VPS Agent Communication |
| `vpsAllocator.js` | VPS Port Allocation |
| `mt5ControlService.js` | MT5 Terminal Control |
| `subscriptionService.js` | Package & Subscription |
| `paymentService.js` | Payment Processing |
| `agentService.js` | Agent Deployment |

### **Support Services**
| Service | Responsibility |
|---------|-----------------|
| `mailService.js` | Email Notifications |
| `i18n.js` | Multi-language Support |
| `newsService.js` | News Management |
| `newsSyncService.js` | Auto News Sync |
| `aiService.js` | AI Integration |
| `aiChatService.js` | AI Chat Features |
| `intelAi.js` | Intel AI Features |
| `kbankService.js` | KBANK Payment |
| `scoinService.js` | Scoin Cryptocurrency |
| `backupService.js` | Backup Management |
| `cart.js` | Shopping Cart Logic |
| `payment.js` | Payment Logic |

### **Worker Services**
| Worker | Purpose |
|--------|---------|
| `packageExpiryWorker.js` | Auto Expire Packages |
| `orderAutoCancelService.js` | Auto Cancel Orders |
| `newsyncService.js` | Auto Sync News (15 min interval) |

---

## 📦 Repositories (Data Access)

Implements **Repository Pattern** for Clean Architecture:

```javascript
repositories/
├── usersRepo.js       // User CRUD Operations
└── packagesRepo.js    // Package CRUD Operations
```

**Example Methods**:
- `findById(userId)` - Get User by ID
- `findByEmail(email)` - Get User by Email
- `findByGoogleId(googleId)` - OAuth Lookup
- `createUser(userData)` - Create New User

---

## 🗄️ Database Structure

### **PostgreSQL Configuration**
- **Host**: `DB_HOST` (default: 127.0.0.1)
- **Port**: `DB_PORT` (default: 5432)
- **Database**: `DB_NAME` (default: trading_avelqua)
- **User**: `DB_USER` (default: trading_user)
- **Pool Size**: `DB_POOL_MAX` (default: 20)
- **SSL**: Configurable via `DB_SSL`

### **Database Schemas**
Located in `db/`:
- `001_mt5_production_schema.sql` - Main Tables
- `002_seed_ports_example.sql` - Example Data
- `migrations/` - Version Control Migrations

### **Key Tables Created Automatically**
```sql
scoin_settings          -- Cryptocurrency Settings
scoin_wallets          -- User Wallets
scoin_market_orders    -- Order History
scoin_price_history    -- Price Tracking
(+ many more in schema)
```

---

## 🔐 Authentication & Middleware

### **Middleware Stack** (in execution order)
```javascript
1. Helmet              // Security Headers
2. Express JSON        // Parse JSON Bodies
3. Express URL         // Parse Form Data
4. Cookie Parser       // Parse Cookies
5. Static Files        // Serve Public Assets
6. Session Middleware  // Express Session + Redis
7. Passport Init       // Passport Authentication
8. Language Middleware // i18n Support
9. Inject User         // Attach User to req.user
```

### **Authentication Methods**
- **Local**: Email + Password
- **OAuth**: Google Login
- **API Token**: VPS Agent Authentication
- **Admin**: Role-based Admin Checks

### **Middleware Files**
- `middleware/admin.js` - Admin Role Verification
- `middleware/auth.js` - Authentication Setup
- `middleware/requireAuth.js` - Auth Requirement Check
- `middleware/requireVerified.js` - Email Verification Check

---

## ⚙️ Core Libraries** (`lib/`)

| Library | Purpose |
|---------|---------|
| `adminVpsBridge.js` | Admin-VPS Communication |
| `adminVpsPortPicker.js` | Port Selection Algorithm |
| `agentDeploy.js` | Agent Deployment |
| `mt5AccountPort.js` | MT5 Account-Port Mapping |
| `mt5BotPresets.js` | Bot Template Management |
| `mt5CommandNormalize.js` | Command Standardization |
| `mt5EaSet.js` | EA Settings Management |
| `mt5EquitySync.js` | Equity Synchronization |
| `mt5JournalVerify.js` | Journal Validation |
| `mt5LiveStatus.js` | Real-time Status |
| `mt5LoginCommandVerify.js` | Login Verification |
| `mt5LoginDuplicate.js` | Duplicate Login Check |
| `mt5PackageExpire.js` | Package Expiration Logic |
| `mt5PackagePorts.js` | Port-Package Mapping |
| `mt5PortAccount.js` | Port-Account Relationship |
| `mt5PortEntitlement.js` | Access Rights |
| `mt5Preview.js` | Bot Preview |
| `mt5RunBotResult.js` | Bot Run Results |
| `mt5Server.js` | Server Management |
| `pgSanitize.js` | SQL Injection Prevention |
| `subscriptionPackage.js` | Subscription Logic |

---

## 🌍 Multi-language Support

**Supported Languages**:
- `th.json` - ไทย
- `en.json` - English
- `lo.json` - ລາວ
- `vi.json` - Tiếng Việt
- `my.json` - မြန်မာ

**Localization Services**:
- `services/i18n.js` - Core i18n Implementation
- Language Middleware Auto-detects User Preference
- Session-based Language Persistence

---

## 📊 Static Assets & Public Files

```
public/
├── agent/           # Agent Application Files
├── css/             # Stylesheets
├── downloads/       # Downloadable Files
├── images/          # Images & Logos
├── js/              # Frontend JavaScript
└── mt5-previews/    # Bot Preview Screenshots
```

**Additional Static Paths**:
- `/public` - Main Public Directory
- `/downloads` - Download Files
- `/mt5-previews` - MT5 Preview Images

---

## 🚀 Environment Variables Required

```env
# Database
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=trading_avelqua
DB_USER=trading_user
DB_PASS=password
DB_POOL_MAX=20
DB_SSL=false

# Session & Security
SESSION_SECRET=trading-avelqua-secret
PORT=3061

# Google OAuth
GOOGLE_CLIENT_ID=xxx
GOOGLE_CLIENT_SECRET=xxx
GOOGLE_CALLBACK_URL=xxx

# Optional Services
KBANK_MERCHANT=xxx
SMTP_HOST=xxx
SMTP_PORT=587
SMTP_USER=xxx
SMTP_PASS=xxx
```

---

## 🔄 Request Flow Example

### **User Login Process**
```
1. GET /login                          → render login form
2. POST /auth/login                    → authenticate
3. Passport verify (local/google)      → query usersRepo
4. Session created                     → passport.serializeUser()
5. Redirect to /app                    → requireAuth middleware
6. injectUser middleware               → req.user populated
7. Render dashboard with user data     → res.render('app/dashboard')
```

### **VPS Agent API Flow**
```
1. POST /api/vps-agent/command         → authenticate token
2. vpsAgentApi route handler           → query vpsService
3. vpsService communicates with VPS    → sends MT5 command
4. Response returns status             → res.json({ ok: true })
```

---

## ⚡ Background Workers & Jobs

### **Scheduled Tasks**
| Task | Interval | Function |
|------|----------|----------|
| Auto News Sync | 15 minutes | `syncNewsNow()` |
| Package Expiry | On request | `/internal/package-expiry-sweep` |
| Order Auto Cancel | Background | `orderAutoCancelService` |

---

## 🚨 Potential Issues & Best Practices

### **✅ Good Practices Found**
- Repository pattern for data access
- Middleware-based architecture
- Environment variable configuration
- Rate limiting on auth endpoints
- SQL injection prevention (pgSanitize)
- Session management with Redis
- Error handling middleware
- Multi-language support

### **⚠️ Areas to Review**

1. **Route Duplication**
   - Multiple routes mounted on same paths (e.g., `/admin`)
   - Could cause route conflicts - check order of `app.use()`

2. **Error Handling**
   - Global error middleware exists but may need better logging
   - Some try-catch blocks are silent failures

3. **Input Validation**
   - Should add request validation middleware (e.g., joi, zod)
   - Sanitization happens but validation is inconsistent

4. **Database Queries**
   - Direct query() calls throughout codebase
   - Consider parameterized queries everywhere

5. **API Documentation**
   - No OpenAPI/Swagger documentation found
   - Should document API endpoints

6. **Testing**
   - No test files visible in structure
   - Need unit & integration tests

7. **Performance**
   - Connection pool size is 20 - may need tuning
   - Consider adding query result caching

8. **Security**
   - Google OAuth may need state parameter validation
   - CSRF tokens not visible in forms

---

## 📝 File Statistics

| Category | Count | Purpose |
|----------|-------|---------|
| Routes | 23 | API & Web Endpoints |
| Services | 23 | Business Logic |
| Middleware | 4 | Request Processing |
| Libraries | 20+ | Utilities & Helpers |
| Views (EJS) | ? | UI Templates |
| Database Schemas | 3 | Data Structure |

---

## 🎯 Quick Start Checklist

```bash
# 1. Install Dependencies
npm install

# 2. Setup PostgreSQL
# Restore backup_before_public_id.sql or run migrations
psql -U trading_user -d trading_avelqua < db/001_mt5_production_schema.sql

# 3. Configure Environment
cp .env.example .env
# Edit .env with database credentials

# 4. Start Server
npm start
# Server runs on http://localhost:3061

# 5. Access Admin/App
# Admin: http://localhost:3061/admin
# App: http://localhost:3061/app
# Public: http://localhost:3061
```

---

## 📞 Support Files

- **Migration Script**: `scripts/migrate-json-to-postgres.js`
- **Backup Script**: `scripts/backup-now.js`
- **Installation Scripts**: `scripts/install-*.sh` (Linux/Windows)
- **Data**: `data.json`, `data/data.json`

---

**สรุป**: โปรแกรมนี้เป็น Enterprise-level Trading Platform ที่มีโครงสร้างดี แม้มีบางจุดที่ต้องปรับปรุง โดยเฉพาะการ validate input และการเขียน test cases
