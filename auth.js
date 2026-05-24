const crypto = require('crypto');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

function getGoogleConfig() {
    return {
        clientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
        clientSecret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
        redirectUri: (process.env.GOOGLE_REDIRECT_URI || '').trim()
    };
}

function getUsers() {
    const usersFile = path.join(__dirname, 'users.json');
    try {
        if (!fs.existsSync(usersFile)) {
            fs.writeFileSync(usersFile, JSON.stringify({}, null, 2));
        }
        return JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    } catch (err) {
        console.log('getUsers error:', err.message);
        return {};
    }
}

function saveUsers(users) {
    const usersFile = path.join(__dirname, 'users.json');
    try {
        fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
    } catch (err) {
        console.log('saveUsers error:', err.message);
    }
}

function ensureUserBalance(email) {
    if (!email) return;
    const users = getUsers();
    if (!users[email]) {
        users[email] = { balance: 100, createdAt: Date.now() };
        saveUsers(users);
    }
}

function authConfigured() {
    const { clientId, clientSecret } = getGoogleConfig();
    return !!(clientId && clientSecret);
}

function getBaseUrl(req) {
    if (process.env.BASE_URL) {
        return String(process.env.BASE_URL).trim().replace(/\/$/, '');
    }
    if (process.env.RENDER_EXTERNAL_URL) {
        return String(process.env.RENDER_EXTERNAL_URL).trim().replace(/\/$/, '');
    }
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
    const host = req.get('x-forwarded-host') || req.get('host') || 'localhost:3000';
    return `${proto}://${host}`;
}

function getRedirectUri(req) {
    const { redirectUri } = getGoogleConfig();
    if (redirectUri) return redirectUri.replace(/\/$/, '');
    return `${getBaseUrl(req)}/auth/google/callback`;
}

function setupAuth(app) {
    const sessionSecret = (
        process.env.SESSION_SECRET ||
        getGoogleConfig().clientSecret ||
        'drumai-dev-session-change-me'
    ).trim();

    app.set('trust proxy', 1);

    app.use(
        session({
            name: 'drumai.sid',
            secret: sessionSecret,
            resave: false,
            saveUninitialized: false,
            cookie: {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                maxAge: 7 * 24 * 60 * 60 * 1000
            }
        })
    );

    app.get('/auth/status', (req, res) => {
        const cfg = getGoogleConfig();
        res.json({
            configured: authConfigured(),
            redirectUri: getRedirectUri(req),
            loggedIn: !!(req.session && req.session.user)
        });
    });

    app.get('/auth/google', (req, res) => {
        const { clientId } = getGoogleConfig();

        if (!authConfigured()) {
            return res.status(503).send(
                'Google OAuth: добавь GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET в .env и перезапусти сервер'
            );
        }

        const state = crypto.randomBytes(16).toString('hex');
        req.session.oauthState = state;

        const redirectUri = getRedirectUri(req);
        const params = new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: 'openid email profile',
            state,
            access_type: 'online',
            prompt: 'select_account'
        });

        res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
    });

    app.get('/auth/google/callback', async (req, res) => {
        const { clientId, clientSecret } = getGoogleConfig();

        if (!authConfigured()) {
            return res.redirect('/?auth_error=not_configured');
        }

        const { code, state, error } = req.query;

        if (error) {
            const errCode = String(error);
            if (errCode === 'deleted_client' || errCode === 'invalid_client') {
                console.log(
                    'Google OAuth:',
                    errCode,
                    '— создай новый OAuth Client в Google Cloud и обнови .env'
                );
            }
            return res.redirect(`/?auth_error=${encodeURIComponent(errCode)}`);
        }

        if (!code || !state || state !== req.session.oauthState) {
            return res.redirect('/?auth_error=invalid_state');
        }

        delete req.session.oauthState;

        try {
            const redirectUri = getRedirectUri(req);
            const body = new URLSearchParams({
                code: String(code),
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code'
            });

            const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString()
            });

            const tokenData = await tokenRes.json();
            if (!tokenRes.ok || !tokenData.access_token) {
                console.log('Google token error', tokenData);
                const errCode = tokenData.error || 'token';
                return res.redirect(`/?auth_error=${encodeURIComponent(errCode)}`);
            }

            const profileRes = await fetch(GOOGLE_USERINFO_URL, {
                headers: { Authorization: `Bearer ${tokenData.access_token}` }
            });

            const profile = await profileRes.json();
            if (!profileRes.ok || !profile.email) {
                console.log('Google profile error', profile);
                return res.redirect('/?auth_error=profile');
            }

            req.session.user = {
                id: profile.id,
                email: profile.email,
                name: profile.name || profile.email.split('@')[0],
                avatar: profile.picture || ''
            };

            ensureUserBalance(profile.email);

            req.session.save((err) => {
                if (err) console.log('session save', err.message);
                res.redirect('/?auth=success');
            });
        } catch (err) {
            console.log('OAuth callback', err.message);
            res.redirect('/?auth_error=server');
        }
    });

    app.get('/auth/me', (req, res) => {
        if (req.session && req.session.user) {
            return res.json({
                loggedIn: true,
                user: {
                    name: req.session.user.name,
                    email: req.session.user.email,
                    avatar: req.session.user.avatar
                }
            });
        }
        res.json({ loggedIn: false });
    });

    app.post('/auth/logout', (req, res) => {
        if (!req.session) {
            return res.json({ success: true });
        }
        req.session.destroy((err) => {
            if (err) console.log('logout', err.message);
            res.clearCookie('drumai.sid', {
                httpOnly: true,
                sameSite: 'lax',
                secure: process.env.NODE_ENV === 'production'
            });
            res.json({ success: true });
        });
    });
}

module.exports = { setupAuth, authConfigured, getGoogleConfig, getRedirectUri };
