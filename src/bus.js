// Tiny in-process registry + event hub so one feature can use another's API (features otherwise only talk through IPC).
// agents.js fills bus.agents and emits 'agent-event'; team.js reads them. Everything stays in the main process.
const subs = {};
module.exports = {
  agents: null,
  on(name, fn) { (subs[name] ||= new Set()).add(fn); return () => subs[name].delete(fn); },
  emit(name, data) { for (const f of subs[name] || []) { try { f(data); } catch (e) { console.error('bus handler failed:', e.message); } } },
};
