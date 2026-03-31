const express = require('express');
const router = express.Router();
const { supabase, supabaseAuth } = require('../config/supabase');
const { authenticateUser, requireRole } = require('../middleware/auth');

// POST /api/auth/register — new user + organization
router.post('/register', async (req, res) => {
  const { email, password, name, organizationName } = req.body;

  if (!email || !password || !name || !organizationName) {
    return res.status(400).json({ error: 'All fields are required: email, password, name, organizationName' });
  }

  try {
    // 1. Create auth user in Supabase Auth
    const { data: authData, error: authError } = await supabaseAuth.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    // 2. Create organization
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .insert({ name: organizationName })
      .select()
      .single();

    if (orgError) {
      // Cleanup: delete auth user if org creation fails
      await supabaseAuth.auth.admin.deleteUser(authData.user.id);
      return res.status(500).json({ error: 'Failed to create organization' });
    }

    // 3. Create user profile with 'main' role
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .insert({
        id: authData.user.id,
        email,
        name,
        organization_id: org.id,
        role: 'main'
      })
      .select()
      .single();

    if (profileError) {
      await supabase.from('organizations').delete().eq('id', org.id);
      await supabaseAuth.auth.admin.deleteUser(authData.user.id);
      return res.status(500).json({ error: 'Failed to create user profile' });
    }

    // 4. Sign in to get tokens
    const { data: session, error: signInError } = await supabaseAuth.auth.signInWithPassword({
      email,
      password
    });

    if (signInError) {
      return res.status(500).json({ error: 'Account created but login failed. Please login manually.' });
    }

    res.status(201).json({
      user: profile,
      organization: org,
      session: {
        access_token: session.session.access_token,
        refresh_token: session.session.refresh_token,
        expires_at: session.session.expires_at
      }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });

    if (error) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Get user profile
    const { data: profile } = await supabase
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .single();

    // Update last_seen_at
    await supabase
      .from('users')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', data.user.id);

    res.json({
      user: profile,
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/logout
router.post('/logout', authenticateUser, async (req, res) => {
  try {
    const token = req.headers.authorization.split(' ')[1];
    await supabaseAuth.auth.admin.signOut(token);
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    // Even if signOut fails server-side, client should discard the token
    res.json({ message: 'Logged out' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    return res.status(400).json({ error: 'Refresh token is required' });
  }

  try {
    const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token });

    if (error) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    res.json({
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at
      }
    });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// POST /api/auth/invite — invite a team member (main/manager only)
router.post('/invite', authenticateUser, requireRole('manager'), async (req, res) => {
  const { email, name, role } = req.body;

  if (!email || !name) {
    return res.status(400).json({ error: 'Email and name are required' });
  }

  const inviteRole = role || 'agent';
  if (!['manager', 'agent'].includes(inviteRole)) {
    return res.status(400).json({ error: 'Role must be manager or agent' });
  }

  // Only main can invite managers
  if (inviteRole === 'manager' && req.user.role !== 'main') {
    return res.status(403).json({ error: 'Only the main account can invite managers' });
  }

  try {
    // Check if user already exists in this org
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (existing) {
      return res.status(400).json({ error: 'User already exists in this organization' });
    }

    // Generate invite via Supabase Auth
    const { data: authData, error: authError } = await supabaseAuth.auth.admin.inviteUserByEmail(email);

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    // Create user profile
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .insert({
        id: authData.user.id,
        email,
        name,
        organization_id: req.user.organization_id,
        role: inviteRole,
        invited_by: req.user.id,
        invited_at: new Date().toISOString()
      })
      .select()
      .single();

    if (profileError) {
      await supabaseAuth.auth.admin.deleteUser(authData.user.id);
      return res.status(500).json({ error: 'Failed to create user profile' });
    }

    res.status(201).json({ user: profile, message: 'Invite sent successfully' });
  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Invitation failed' });
  }
});

// POST /api/auth/accept-invite
router.post('/accept-invite', async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ error: 'Token and password are required' });
  }

  try {
    const { data, error } = await supabaseAuth.auth.verifyOtp({
      token_hash: token,
      type: 'invite'
    });

    if (error) {
      return res.status(400).json({ error: 'Invalid or expired invite token' });
    }

    // Update password
    const { error: updateError } = await supabaseAuth.auth.admin.updateUserById(data.user.id, {
      password
    });

    if (updateError) {
      return res.status(500).json({ error: 'Failed to set password' });
    }

    // Sign in
    const { data: session, error: signInError } = await supabaseAuth.auth.signInWithPassword({
      email: data.user.email,
      password
    });

    if (signInError) {
      return res.status(500).json({ error: 'Invite accepted but login failed. Please login manually.' });
    }

    const { data: profile } = await supabase
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .single();

    res.json({
      user: profile,
      session: {
        access_token: session.session.access_token,
        refresh_token: session.session.refresh_token,
        expires_at: session.session.expires_at
      }
    });
  } catch (err) {
    console.error('Accept invite error:', err);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// GET /api/auth/me — current user info
router.get('/me', authenticateUser, async (req, res) => {
  try {
    const { data: org } = await supabase
      .from('organizations')
      .select('*')
      .eq('id', req.user.organization_id)
      .single();

    res.json({
      user: req.user,
      organization: org
    });
  } catch (err) {
    console.error('Get me error:', err);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

module.exports = router;
