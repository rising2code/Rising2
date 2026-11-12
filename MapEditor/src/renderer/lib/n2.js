// Parser and writer for Nebula Device 2 ".n2" scripts (the TCL-style files that describe
// a level, a mission or an entity template).
//
// A script is a list of lines:
//   # comment                      -> kept verbatim
//   new <class> <name>             -> creates a child node
//   sel <name>                     -> makes that child the current node
//   sel ..                         -> goes back to the parent
//   .<command> <arg> <arg> ...     -> calls a command on the current node
//
// The parser turns this into a tree of N2Node objects whose `items` keep the original
// order of commands, comments and children, so writing it back gives the same file.

let nextUid = 1;

export class N2Node {
  constructor(cls, name) {
    this.uid = nextUid++;
    this.cls = cls;          // Nebula class, e.g. "nstaticnode"
    this.name = name;        // node name, e.g. "rockpile_450X550_02?5"
    this.items = [];         // {t:'cmd', name, args[]} | {t:'node', node} | {t:'raw', text}
    this.parent = null;
    this.origPath = null;    // path at load time (used to carry baked lightmaps over)
  }

  get children() {
    return this.items.filter((i) => i.t === 'node').map((i) => i.node);
  }

  get commands() {
    return this.items.filter((i) => i.t === 'cmd');
  }

  /** First command with this name, or undefined. */
  cmd(name) {
    return this.items.find((i) => i.t === 'cmd' && i.name === name);
  }

  cmdsNamed(name) {
    return this.items.filter((i) => i.t === 'cmd' && i.name === name);
  }

  /** Numeric args of the first command with this name, or null. */
  nums(name) {
    const c = this.cmd(name);
    return c ? c.args.map(Number) : null;
  }

  /**
   * Sets a command's args. Creates the command if missing, placing it after `after`
   * (first command found from that list) or as the first command.
   */
  setCmd(name, args, after = []) {
    const c = this.cmd(name);
    if (c) {
      c.args = args.map(String);
      return c;
    }
    const item = { t: 'cmd', name, args: args.map(String) };
    let idx = -1;
    for (const a of after) {
      const found = this.items.findIndex((i) => i.t === 'cmd' && i.name === a);
      if (found >= 0) { idx = found; break; }
    }
    if (idx < 0) {
      // before the first child node, after leading commands
      const firstNode = this.items.findIndex((i) => i.t === 'node');
      idx = firstNode < 0 ? this.items.length - 1 : firstNode - 1;
      // put it at the very start of the command block
      const firstCmd = this.items.findIndex((i) => i.t === 'cmd');
      if (firstCmd >= 0 && (firstNode < 0 || firstCmd < firstNode)) idx = firstCmd - 1;
    }
    this.items.splice(idx + 1, 0, item);
    return item;
  }

  removeCmd(item) {
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);
  }

  addChild(node, index) {
    node.parent = this;
    const item = { t: 'node', node };
    if (index === undefined || index < 0 || index >= this.items.length) this.items.push(item);
    else this.items.splice(index, 0, item);
    return node;
  }

  removeChild(node) {
    const i = this.items.findIndex((it) => it.t === 'node' && it.node === node);
    if (i >= 0) this.items.splice(i, 1);
    node.parent = null;
    return i;
  }

  child(name) {
    const it = this.items.find((i) => i.t === 'node' && i.node.name === name);
    return it ? it.node : undefined;
  }

  /** Slash path from the root (root itself excluded), e.g. "entities/rock?4/RockPile". */
  path() {
    const parts = [];
    for (let n = this; n && n.parent; n = n.parent) parts.unshift(n.name);
    return parts.join('/');
  }

  *walk() {
    yield this;
    for (const it of this.items) if (it.t === 'node') yield* it.node.walk();
  }

  clone() {
    const c = new N2Node(this.cls, this.name);
    c.origPath = this.origPath;
    for (const it of this.items) {
      if (it.t === 'cmd') c.items.push({ t: 'cmd', name: it.name, args: [...it.args] });
      else if (it.t === 'raw') c.items.push({ t: 'raw', text: it.text });
      else c.addChild(it.node.clone());
    }
    return c;
  }
}

/** Splits a command line into tokens. Quoted strings keep their quotes. */
export function tokenize(line) {
  const out = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
    if (i >= n) break;
    let start = i;
    if (line[i] === '"') {
      i++;
      while (i < n && line[i] !== '"') i++;
      i++;
    } else {
      while (i < n && line[i] !== ' ' && line[i] !== '\t') i++;
    }
    out.push(line.slice(start, i));
  }
  return out;
}

export function unquote(s) {
  return s && s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1) : s;
}

export function quote(s) {
  return `"${s}"`;
}

/**
 * Parses an .n2 script. Returns { root, eol, trailingNewline, rootClass }.
 * `root` is an N2Node standing for the object the script is run on (its class comes
 * from the "$class:...$" header comment when present).
 */
export function parseN2(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (trailingNewline) lines.pop();

  const classMatch = text.match(/\$class:([A-Za-z0-9_]+)\$/);
  const root = new N2Node(classMatch ? classMatch[1] : 'nroot', null);
  let cur = root;
  let lastNew = null;

  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const t = line.trim();
    if (t === '' || t.startsWith('#')) {
      cur.items.push({ t: 'raw', text: line });
      continue;
    }
    if (t[0] === '.') {
      const toks = tokenize(t);
      cur.items.push({ t: 'cmd', name: toks[0].slice(1), args: toks.slice(1) });
      continue;
    }
    const toks = tokenize(t);
    if (toks[0] === 'new' && toks.length >= 3) {
      const node = new N2Node(toks[1], toks.slice(2).join(' '));
      cur.addChild(node);
      lastNew = node;
      continue;
    }
    if (toks[0] === 'sel' && toks.length >= 2) {
      const target = toks.slice(1).join(' ');
      if (target === '..') {
        if (!cur.parent) throw new Error(`line ${ln + 1}: "sel .." above the root`);
        cur = cur.parent;
      } else {
        const n = lastNew && lastNew.parent === cur && lastNew.name === target ? lastNew : cur.child(target);
        if (!n) throw new Error(`line ${ln + 1}: sel of unknown node "${target}"`);
        cur = n;
      }
      continue;
    }
    // anything else (rare): keep verbatim
    cur.items.push({ t: 'raw', text: line });
  }

  for (const n of root.walk()) n.origPath = n.path();
  return { root, eol, trailingNewline };
}

/** Writes the tree back in the same indentation style the game's tools use. */
export function writeN2(doc) {
  const out = [];
  const tabs = (d) => '\t'.repeat(d);
  const emitItems = (node, depth) => {
    for (const it of node.items) {
      if (it.t === 'raw') out.push(it.text);
      else if (it.t === 'cmd') out.push(tabs(depth) + '.' + it.name + (it.args.length ? ' ' + it.args.join(' ') : ''));
      else {
        const c = it.node;
        out.push(tabs(depth) + `new ${c.cls} ${c.name}`);
        out.push(tabs(depth + 1) + `sel ${c.name}`);
        emitItems(c, depth + 1);
        out.push(tabs(depth) + 'sel ..');
      }
    }
  };
  emitItems(doc.root, 0);
  return out.join(doc.eol) + (doc.trailingNewline ? doc.eol : '');
}

/** Name for a copy: "rock?4" -> "rock?<first free number>" among the parent's children. */
export function uniqueChildName(parent, wanted) {
  const base = wanted.includes('?') ? wanted.slice(0, wanted.lastIndexOf('?')) : wanted;
  const taken = new Set(parent.children.map((c) => c.name));
  if (!taken.has(wanted) && !wanted.includes('?')) return wanted;
  let n = 0;
  for (const name of taken) {
    if (name.startsWith(base + '?')) {
      const k = parseInt(name.slice(base.length + 1), 10);
      if (Number.isFinite(k) && k >= n) n = k + 1;
    }
  }
  while (taken.has(`${base}?${n}`)) n++;
  return `${base}?${n}`;
}

/** Formats a number like the game's tools do ("%f"). */
export function fmt(v) {
  if (!Number.isFinite(v)) v = 0;
  const s = v.toFixed(6);
  return s === '-0.000000' ? '0.000000' : s;
}

/**
 * Entity template files (data/entities/**.n2) are the body of a single node: a
 * "$class:xxx$" header, commands and children. Turns one into a node with `name`.
 */
export function nodeFromTemplate(text, name) {
  const { root } = parseN2(text);
  const node = new N2Node(root.cls, name);
  for (const it of root.items) {
    if (it.t === 'raw') continue; // drop the header comments inside a level
    if (it.t === 'node') node.addChild(it.node);
    else node.items.push(it);
  }
  for (const n of node.walk()) n.origPath = null; // new object: no baked lighting
  return node;
}

/** Writes a node as a template file (same format as data/entities/**.n2). */
export function templateFromNode(node, eol = '\r\n') {
  const body = new N2Node(node.cls, null);
  for (const it of node.items) {
    if (it.t === 'cmd' && it.name === 'setposition') continue; // placed where you drop it
    if (it.t === 'node') body.addChild(it.node.clone());
    else if (it.t === 'cmd') body.items.push({ t: 'cmd', name: it.name, args: [...it.args] });
  }
  body.items.unshift(
    { t: 'raw', text: '# ---' },
    { t: 'raw', text: `# $parser:ntclserver$ $class:${node.cls}$` },
    { t: 'raw', text: '# ---' },
  );
  body.items.push({ t: 'raw', text: '# ---' }, { t: 'raw', text: '# Eof' });
  return writeN2({ root: body, eol, trailingNewline: true });
}
