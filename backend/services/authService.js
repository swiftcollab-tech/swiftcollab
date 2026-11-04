// Authentication Service
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query, getClient } = require('../db');
const {
  createOrganizationWithOwner,
  getInvitationForToken,
  acceptInvitation,
} = require('./organizationService');

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m';
const REFRESH_TOKEN_EXPIRES_IN = Number(process.env.REFRESH_TOKEN_EXPIRES_IN_MS) || 7 * 24 * 60 * 60 * 1000;

if (process.env.NODE_ENV === 'production' && JWT_SECRET === 'your-super-secret-key-change-in-production') {
  throw new Error('JWT_SECRET must be configured in production');
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

class AuthService {
  // Hash password
  async hashPassword(password) {
    const salt = await bcrypt.genSalt(12);
    return bcrypt.hash(password, salt);
  }

  // Verify password
  async verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
  }

  // Generate access token
  generateAccessToken(user) {
    return jwt.sign(
      {
        userId: user.id,
        email: user.email,
        name: user.name,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
  }

  // Generate refresh token
  generateRefreshToken() {
    return crypto.randomBytes(64).toString('hex');
  }

  // Verify access token
  verifyAccessToken(token) {
    try {
      return jwt.verify(token, JWT_SECRET);
    } catch (error) {
      return null;
    }
  }

  // Register new user
  async register({ email, password, name, invitationToken = null }) {
    // Validate password strength
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters long');
    }

    const passwordHash = await this.hashPassword(password);
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const client = await getClient();
    let user;
    let organization;

    try {
      await client.query('BEGIN');
      const existingUser = await client.query(
        'SELECT id FROM users WHERE email = $1',
        [email.toLowerCase()]
      );
      if (existingUser.rows.length > 0) {
        throw new Error('User with this email already exists');
      }

      let invitation = null;
      if (invitationToken) {
        invitation = await getInvitationForToken(invitationToken, email, client);
        if (!invitation) throw new Error('Invitation is invalid, expired, or does not match this email');
      }

      const result = await client.query(
        `INSERT INTO users (email, password_hash, name, verification_token)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, name, created_at`,
        [email.toLowerCase(), passwordHash, name, verificationToken]
      );
      user = result.rows[0];

      await client.query('INSERT INTO user_settings (user_id) VALUES ($1)', [user.id]);
      if (invitation) {
        await acceptInvitation({ token: invitationToken, userId: user.id, email: user.email, client });
        organization = {
          id: invitation.organization_id,
          name: invitation.organization_name,
        };
      } else {
        organization = await createOrganizationWithOwner({
          name: `${user.name || user.email.split('@')[0]} Workspace`,
          ownerUserId: user.id,
          client,
        });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // Log the action
    await this.logAuditEvent(user.id, 'USER_REGISTERED', { email: user.email });

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      organization,
      verificationToken,
    };
  }

  // Login user
  async login({ email, password, deviceInfo, ipAddress }) {
    // Find user
    const result = await query(
      'SELECT * FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      throw new Error('Invalid email or password');
    }

    const user = result.rows[0];

    // Check if user is active
    if (!user.is_active) {
      throw new Error('Account is deactivated. Please contact support.');
    }

    // Verify password
    const isValid = await this.verifyPassword(password, user.password_hash);
    if (!isValid) {
      throw new Error('Invalid email or password');
    }

    // Generate tokens
    const accessToken = this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken();

    // Store refresh token in database
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_IN);
    await query(
      `INSERT INTO user_sessions (user_id, refresh_token, device_info, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, hashRefreshToken(refreshToken), deviceInfo, ipAddress, expiresAt]
    );

    // Update last login
    await query(
      'UPDATE users SET last_login_at = NOW() WHERE id = $1',
      [user.id]
    );

    // Log the action
    await this.logAuditEvent(user.id, 'USER_LOGIN', { ipAddress, deviceInfo });

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar_url: user.avatar_url,
      },
      accessToken,
      refreshToken,
      expiresIn: JWT_EXPIRES_IN,
    };
  }

  // Refresh access token
  async refreshToken(refreshToken) {
    // Find valid session
    const result = await query(
      `SELECT s.*, u.id as user_id, u.email, u.name, u.is_active
       FROM user_sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.refresh_token = $1
         AND s.expires_at > NOW()
         AND s.is_revoked = false`,
      [hashRefreshToken(refreshToken)]
    );

    if (result.rows.length === 0) {
      throw new Error('Invalid or expired refresh token');
    }

    const session = result.rows[0];

    if (!session.is_active) {
      throw new Error('Account is deactivated');
    }

    // Generate new access token
    const newAccessToken = this.generateAccessToken({
      id: session.user_id,
      email: session.email,
      name: session.name,
    });

    return {
      accessToken: newAccessToken,
      expiresIn: JWT_EXPIRES_IN,
    };
  }

  // Logout (revoke refresh token)
  async logout(refreshToken) {
    await query(
      'UPDATE user_sessions SET is_revoked = true WHERE refresh_token = $1',
      [hashRefreshToken(refreshToken)]
    );
  }

  // Logout all sessions
  async logoutAll(userId) {
    await query(
      'UPDATE user_sessions SET is_revoked = true WHERE user_id = $1',
      [userId]
    );
    await this.logAuditEvent(userId, 'LOGOUT_ALL_SESSIONS', {});
  }

  // Get user by ID
  async getUserById(userId) {
    const result = await query(
      `SELECT u.id, u.email, u.name, u.avatar_url, u.created_at, u.is_verified,
              s.theme, s.timezone, s.notifications_enabled
       FROM users u
       LEFT JOIN user_settings s ON u.id = s.user_id
       WHERE u.id = $1 AND u.is_active = true`,
      [userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  }

  // Update user profile
  async updateProfile(userId, { name, avatar_url }) {
    const result = await query(
      `UPDATE users SET name = COALESCE($1, name), avatar_url = COALESCE($2, avatar_url)
       WHERE id = $3
       RETURNING id, email, name, avatar_url`,
      [name, avatar_url, userId]
    );

    await this.logAuditEvent(userId, 'PROFILE_UPDATED', { name });

    return result.rows[0];
  }

  // Change password
  async changePassword(userId, { currentPassword, newPassword }) {
    // Get current password hash
    const result = await query(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error('User not found');
    }

    // Verify current password
    const isValid = await this.verifyPassword(currentPassword, result.rows[0].password_hash);
    if (!isValid) {
      throw new Error('Current password is incorrect');
    }

    // Validate new password
    if (newPassword.length < 8) {
      throw new Error('New password must be at least 8 characters long');
    }

    // Hash and update new password
    const newPasswordHash = await this.hashPassword(newPassword);
    await query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [newPasswordHash, userId]
    );

    // Revoke all sessions except current (force re-login on other devices)
    await this.logAuditEvent(userId, 'PASSWORD_CHANGED', {});
  }

  // Request password reset
  async requestPasswordReset(email) {
    const result = await query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    // Don't reveal if user exists
    if (result.rows.length === 0) {
      return { message: 'If the email exists, a reset link will be sent' };
    }

    const userId = result.rows[0].id;
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600000); // 1 hour

    await query(
      `UPDATE users SET reset_password_token = $1, reset_password_expires = $2
       WHERE id = $3`,
      [resetToken, expires, userId]
    );

    await this.logAuditEvent(userId, 'PASSWORD_RESET_REQUESTED', { email });

    return { resetToken, message: 'Password reset token generated' };
  }

  // Reset password with token
  async resetPassword(resetToken, newPassword) {
    const result = await query(
      `SELECT id FROM users
       WHERE reset_password_token = $1
         AND reset_password_expires > NOW()`,
      [resetToken]
    );

    if (result.rows.length === 0) {
      throw new Error('Invalid or expired reset token');
    }

    if (newPassword.length < 8) {
      throw new Error('Password must be at least 8 characters long');
    }

    const userId = result.rows[0].id;
    const passwordHash = await this.hashPassword(newPassword);

    await query(
      `UPDATE users
       SET password_hash = $1, reset_password_token = NULL, reset_password_expires = NULL
       WHERE id = $2`,
      [passwordHash, userId]
    );

    // Revoke all sessions
    await this.logoutAll(userId);
    await this.logAuditEvent(userId, 'PASSWORD_RESET_COMPLETED', {});

    return { message: 'Password reset successful' };
  }

  // Log audit event
  async logAuditEvent(userId, action, details, ipAddress = null, userAgent = null) {
    try {
      await query(
        `INSERT INTO audit_logs (user_id, action, details, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, action, JSON.stringify(details), ipAddress, userAgent]
      );
    } catch (error) {
      console.error('[Auth] Failed to log audit event:', error.message);
    }
  }

  // Clean up expired sessions (run periodically)
  async cleanupExpiredSessions() {
    const result = await query(
      'DELETE FROM user_sessions WHERE expires_at < NOW() OR is_revoked = true'
    );
    console.log(`[Auth] Cleaned up ${result.rowCount} expired sessions`);
  }
}

module.exports = new AuthService();
