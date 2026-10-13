// feature: ui-settings (main process): window background colour (no flash of the wrong theme at startup)
// and the file dialogs for exporting / importing settings.
module.exports = function (ctx) {
  const HEX = /^#[0-9a-f]{6}$/i;
  const setBg = (hex) => { try { if (HEX.test(hex)) ctx.window()?.setBackgroundColor(hex); } catch { /* window gone */ } };

  // The window is created just before features load, so this lands before the first paint.
  setBg(ctx.featureSettings('ui-settings').bg);

  ctx.handle('feat:ui-settings:bg', (hex) => { setBg(String(hex)); return true; });

  ctx.handle('feat:ui-settings:info', () => ({ dataDir: ctx.dataDir, settingsFile: ctx.path.join(ctx.dataDir, 'settings.json') }));

  ctx.handle('feat:ui-settings:export', async (text) => {
    if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) throw new Error('Nothing to export.');
    const r = await ctx.dialog.showSaveDialog(ctx.window(), {
      title: 'Export Faber settings',
      defaultPath: ctx.path.join(ctx.workspace() || ctx.os.homedir(), 'faber-settings.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    ctx.fs.writeFileSync(r.filePath, text);
    return { path: r.filePath };
  });

  ctx.handle('feat:ui-settings:import', async () => {
    const r = await ctx.dialog.showOpenDialog(ctx.window(), {
      title: 'Import Faber settings',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    const file = r.filePaths[0];
    if (ctx.fs.statSync(file).size > 1024 * 1024) throw new Error('That file is too large to be a settings file.');
    let data;
    try { data = JSON.parse(ctx.fs.readFileSync(file, 'utf8')); } catch { throw new Error('That file is not valid JSON.'); }
    return { data, path: file };
  });
};
