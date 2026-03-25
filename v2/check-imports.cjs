const fs = require('fs');
const path = require('path');

function scan(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory() && !f.name.startsWith('.') && f.name !== 'node_modules') {
      scan(p);
    } else if (f.name.endsWith('.jsx') || f.name.endsWith('.js')) {
      const code = fs.readFileSync(p, 'utf8');
      const imports = [...code.matchAll(/from\s+['"](\.\.[/\\]|\.\/)(.*?)['"]/g)];
      for (const m of imports) {
        const rel = m[1] + m[2];
        const dir2 = path.dirname(p);
        const resolved = path.resolve(dir2, rel);
        if (!fs.existsSync(resolved) && !fs.existsSync(resolved + '.js') && !fs.existsSync(resolved + '.jsx')) {
          console.log(path.relative(path.join(__dirname, 'src'), p) + '  ->  MISSING: ' + rel);
        }
      }
    }
  }
}

scan(path.join(__dirname, 'src'));
