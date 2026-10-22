// Is a session's claude process still running? A dead PID, or a live PID whose
// process started at a different time from the one the registry recorded
// (the system reused the number), both mean the session is gone.
'use strict';
const focus = require('./focus');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // alive, owned by someone else
  }
}

/**
 * PIDs of the rows whose process is gone. Rows are { pid, procStart? }.
 * `createdAt(pid)` returns the process start time in ms or null when
 * it cannot tell; a null never ends a session.
 */
function deadPids(rows, { alive = isAlive, createdAt = focus.createdAt } = {}) {
  const dead = [];
  for (const row of rows) {
    if (!alive(row.pid)) dead.push(row.pid);
    else if (row.procStart && !focus.sameStart(row.procStart, createdAt(row.pid))) dead.push(row.pid);
  }
  return dead;
}

module.exports = { isAlive, deadPids };
