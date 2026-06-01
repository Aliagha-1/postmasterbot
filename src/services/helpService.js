const { pool } = require('../db/postgres');

async function getHelpButtons() {
  const { rows } = await pool.query(
    'SELECT * FROM help_buttons WHERE is_active = true ORDER BY button_order ASC'
  );
  return rows;
}

async function addHelpButton(buttonText, buttonAction, content) {
  const { rows: maxOrder } = await pool.query(
    'SELECT COALESCE(MAX(button_order), 0) + 1 as next_order FROM help_buttons'
  );
  
  const { rows } = await pool.query(
    `INSERT INTO help_buttons (button_text, button_action, content_type, content, button_order) 
     VALUES ($1, $2, 'text', $3, $4) RETURNING *`,
    [buttonText, buttonAction, content, maxOrder[0].next_order]
  );
  return rows[0];
}

async function updateHelpButton(id, buttonText, content) {
  const { rows } = await pool.query(
    'UPDATE help_buttons SET button_text = $1, content = $2 WHERE id = $3 RETURNING *',
    [buttonText, content, id]
  );
  return rows[0];
}

async function deleteHelpButton(id) {
  await pool.query('DELETE FROM help_buttons WHERE id = $1', [id]);
}

module.exports = {
  getHelpButtons,
  addHelpButton,
  updateHelpButton,
  deleteHelpButton
};
