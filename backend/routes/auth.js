// Authentication Routes
const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const { getInvitationSummary } = require('../services/organizationService');
const {
  authenticateToken,
  rateLimitLogin,
  recordFailedLogin,
  clearLoginAttempts,
} = require('../middleware/auth');

function refreshCookieOptions() {
  const isProduction = process.env.NODE_ENV === 'production';
  const sameSite = process.env.COOKIE_SAME_SITE || (isProduction ? 'lax' : 'lax');
  const options = {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProduction,
    sameSite,
    path: '/api/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
  if (process.env.COOKIE_DOMAIN) options.domain = process.env.COOKIE_DOMAIN;
  return options;
}

// GET /api/auth/invitation?token=... lets the invitation landing page show
// trusted organization details without exposing the stored token hash.
router.get('/invitation', async (req, res) => {
  try {
    res.json({ invitation: await getInvitationSummary(req.query.token) });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, invitationToken } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await authService.register({ email, password, name, invitationToken });

    res.status(201).json({
      message: 'Registration successful',
      user: result.user,
      organization: result.organization,
    });
  } catch (error) {
    console.error('[Auth] Registration error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// POST /api/auth/login
router.post('/login', rateLimitLogin, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const deviceInfo = req.headers['user-agent'] || 'Unknown';
    const ipAddress = req.ip || req.connection.remoteAddress;

    const result = await authService.login({
      email,
      password,
      deviceInfo,
      ipAddress,
    });

    // Clear failed login attempts on success
    clearLoginAttempts(req);

    // Set refresh token as HTTP-only cookie
    res.cookie('refreshToken', result.refreshToken, refreshCookieOptions());

    res.json({
      user: result.user,
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
    });
  } catch (error) {
    console.error('[Auth] Login error:', error.message);
    recordFailedLogin(req);
    res.status(401).json({ error: error.message });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    // Get refresh token from cookie or body
    const refreshToken = req.cookies?.refreshToken || req.body.refreshToken;

    if (!refreshToken) {
      return res.status(401).json({ error: 'Refresh token required' });
    }

    const result = await authService.refreshToken(refreshToken);

    res.json({
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
    });
  } catch (error) {
    console.error('[Auth] Refresh error:', error.message);
    res.status(401).json({ error: error.message });
  }
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken || req.body.refreshToken;

    if (refreshToken) {
      await authService.logout(refreshToken);
    }

    // Clear cookie
    res.clearCookie('refreshToken', refreshCookieOptions());

    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('[Auth] Logout error:', error.message);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// POST /api/auth/logout-all
router.post('/logout-all', authenticateToken, async (req, res) => {
  try {
    await authService.logoutAll(req.user.userId);
    res.clearCookie('refreshToken', refreshCookieOptions());
    res.json({ message: 'Logged out from all devices' });
  } catch (error) {
    console.error('[Auth] Logout all error:', error.message);
    res.status(500).json({ error: 'Failed to logout from all devices' });
  }
});

// GET /api/auth/me
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await authService.getUserById(req.user.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('[Auth] Get user error:', error.message);
    res.status(500).json({ error: 'Failed to get user data' });
  }
});

// PUT /api/auth/profile
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { name, avatar_url } = req.body;
    const user = await authService.updateProfile(req.user.userId, { name, avatar_url });
    res.json({ user });
  } catch (error) {
    console.error('[Auth] Update profile error:', error.message);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// PUT /api/auth/password
router.put('/password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }

    await authService.changePassword(req.user.userId, { currentPassword, newPassword });
    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('[Auth] Change password error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const result = await authService.requestPasswordReset(email);

    // In production, send email with reset link instead of returning token
    res.json({ message: result.message });
  } catch (error) {
    console.error('[Auth] Forgot password error:', error.message);
    res.status(500).json({ error: 'Failed to process password reset' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password required' });
    }

    await authService.resetPassword(token, newPassword);
    res.json({ message: 'Password reset successful. Please login with your new password.' });
  } catch (error) {
    console.error('[Auth] Reset password error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
