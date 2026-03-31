const { supabase, supabaseAuth } = require('../config/supabase');

// Verify JWT and attach user to request
async function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // Use separate auth client so getUser() doesn't taint the data client
    const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Get user profile with organization info
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return res.status(401).json({ error: 'User profile not found' });
    }

    req.user = {
      id: user.id,
      email: user.email,
      ...profile
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// Role-based access: 'main' = only main, 'manager' = main + manager, 'agent' = all
function requireRole(minRole) {
  const hierarchy = { main: 3, manager: 2, agent: 1 };

  return (req, res, next) => {
    const userLevel = hierarchy[req.user.role] || 0;
    const requiredLevel = hierarchy[minRole] || 0;

    if (userLevel < requiredLevel) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Agent can only access their own conversations
function requireOwnConversation() {
  return async (req, res, next) => {
    if (req.user.role === 'main' || req.user.role === 'manager') {
      return next();
    }

    const conversationId = req.params.id || req.params.conversationId;
    if (!conversationId) return next();

    const { data, error } = await supabase
      .from('conversations')
      .select('assigned_to')
      .eq('id', conversationId)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (data.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'You can only access your own conversations' });
    }

    next();
  };
}

module.exports = { authenticateUser, requireRole, requireOwnConversation };
