// Tiny in-process registry so one feature can use another's API (features otherwise only talk through IPC).
// agents.js fills bus.agents; team.js reads it. Everything stays in the main process.
module.exports = { agents: null };
