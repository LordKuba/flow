const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticateUser } = require('../middleware/auth');
const { broadcastNewTask } = require('../services/realtime');
const { notifyTaskAssigned } = require('../services/notifications');

router.use(authenticateUser);

// GET /api/tasks
router.get('/', async (req, res) => {
  try {
    const { status, assigned_to, priority, limit = 50, offset = 0 } = req.query;
    const orgId = req.user.organization_id;

    let query = supabase
      .from('tasks')
      .select('*, assigned_user:users!tasks_assigned_to_fkey(id, name), contact:contacts(id, name)', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('due_date', { ascending: true, nullsFirst: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (priority) query = query.eq('priority', priority);

    // Agents only see their own tasks
    if (req.user.role === 'agent') {
      query = query.eq('assigned_to', req.user.id);
    } else if (assigned_to) {
      query = query.eq('assigned_to', assigned_to);
    }

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ tasks: data, total: count });
  } catch (err) {
    console.error('List tasks error:', err);
    res.status(500).json({ error: 'Failed to list tasks' });
  }
});

// POST /api/tasks
router.post('/', async (req, res) => {
  try {
    const { title, description, priority, assigned_to, due_date, contact_id, conversation_id, source_message } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const { data, error } = await supabase
      .from('tasks')
      .insert({
        organization_id: req.user.organization_id,
        title, description,
        priority: priority || 'medium',
        status: 'open',
        assigned_to: assigned_to || req.user.id,
        due_date, contact_id, conversation_id, source_message,
        created_by: req.user.id
      })
      .select('*, assigned_user:users!tasks_assigned_to_fkey(id, name)')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Broadcast new task to org via Realtime
    broadcastNewTask(req.user.organization_id, { task: data, assignedUserId: data.assigned_to });

    // In-app notification to assignee
    await notifyTaskAssigned({
      orgId: req.user.organization_id,
      taskId: data.id,
      taskTitle: data.title,
      assignedTo: data.assigned_to
    });

    res.status(201).json(data);
  } catch (err) {
    console.error('Create task error:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// PUT /api/tasks/:id
router.put('/:id', async (req, res) => {
  try {
    const { title, description, priority, assigned_to, due_date } = req.body;

    const { data, error } = await supabase
      .from('tasks')
      .update({ title, description, priority, assigned_to, due_date })
      .eq('id', req.params.id)
      .eq('organization_id', req.user.organization_id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ error: 'Task not found' });
    res.json(data);
  } catch (err) {
    console.error('Update task error:', err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// PUT /api/tasks/:id/status
router.put('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['open', 'in_progress', 'done'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${valid.join(', ')}` });
    }

    const { data, error } = await supabase
      .from('tasks')
      .update({ status })
      .eq('id', req.params.id)
      .eq('organization_id', req.user.organization_id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ error: 'Task not found' });
    res.json(data);
  } catch (err) {
    console.error('Update task status error:', err);
    res.status(500).json({ error: 'Failed to update task status' });
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('tasks')
      .delete()
      .eq('id', req.params.id)
      .eq('organization_id', req.user.organization_id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Task deleted' });
  } catch (err) {
    console.error('Delete task error:', err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

module.exports = router;
