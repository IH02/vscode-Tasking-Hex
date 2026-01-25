import * as vscode from 'vscode';

type DumpRow = {
  address: number;
  words: string[];
  ascii: string;
};

function isHexFilePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.hex') || lower.endsWith('.ihex') || lower.endsWith('.ihx');
}

function toHex(value: number, width: number): string {
  return value.toString(16).toUpperCase().padStart(width, '0');
}

function parseIntelHex(content: string): Map<number, number> {
  const bytes = new Map<number, number>();
  let base = 0;

  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || !line.startsWith(':') || line.length < 11) continue;

    const ll = parseInt(line.slice(1, 3), 16);
    const addr = parseInt(line.slice(3, 7), 16);
    const rectype = parseInt(line.slice(7, 9), 16);
    const data = line.slice(9, 9 + ll * 2);

    if (Number.isNaN(ll) || Number.isNaN(addr) || Number.isNaN(rectype)) continue;

    if (rectype === 0x00) {
      for (let i = 0; i < ll; i += 1) {
        const byteHex = data.slice(i * 2, i * 2 + 2);
        const value = parseInt(byteHex, 16);
        if (Number.isNaN(value)) continue;
        const absolute = base + addr + i;
        bytes.set(absolute, value);
      }
    } else if (rectype === 0x04 && ll === 2) {
      const upper = parseInt(data, 16);
      if (!Number.isNaN(upper)) {
        base = upper << 16;
      }
    } else if (rectype === 0x02 && ll === 2) {
      const seg = parseInt(data, 16);
      if (!Number.isNaN(seg)) {
        base = seg << 4;
      }
    } else if (rectype === 0x01) {
      break;
    }
  }

  return bytes;
}

function buildIntelHex(bytes: Map<number, number>): string {
  const addresses = [...bytes.keys()].sort((a, b) => a - b);
  if (addresses.length === 0) return ':00000001FF';

  const lines: string[] = [];
  let currentUpper = -1;

  const emitRecord = (addr16: number, type: number, data: number[]): void => {
    const ll = data.length;
    const sum = ll + ((addr16 >> 8) & 0xFF) + (addr16 & 0xFF) + type + data.reduce((a, b) => a + b, 0);
    const csum = ((-sum) & 0xFF);
    const payload = data.map(b => toHex(b, 2)).join('');
    lines.push(`:${toHex(ll, 2)}${toHex(addr16, 4)}${toHex(type, 2)}${payload}${toHex(csum, 2)}`);
  };

  let i = 0;
  while (i < addresses.length) {
    const start = addresses[i];
    const upper = (start >>> 16) & 0xFFFF;
    if (upper !== currentUpper) {
      currentUpper = upper;
      emitRecord(0x0000, 0x04, [(upper >> 8) & 0xFF, upper & 0xFF]);
    }

    const chunk: number[] = [];
    let addr = start;
    while (i < addresses.length && addresses[i] === addr && chunk.length < 16) {
      chunk.push(bytes.get(addr) as number);
      i += 1;
      addr += 1;
    }

    emitRecord(start & 0xFFFF, 0x00, chunk);
  }

  lines.push(':00000001FF');
  return lines.join('\n');
}

function toDumpRows(bytes: Map<number, number>): DumpRow[] {
  const entries = [...bytes.keys()].sort((a, b) => a - b);

  const rowBases = new Set<number>();
  for (const addr of entries) {
    rowBases.add(addr & ~0xF);
  }

  const rows = [...rowBases].sort((a, b) => a - b);
  const result: DumpRow[] = [];

  for (const base of rows) {
    const words: string[] = [];
    const ascii: string[] = [];
    for (let word = 0; word < 4; word += 1) {
      const bytesInWord: (number | undefined)[] = [];
      for (let i = 0; i < 4; i += 1) {
        const value = bytes.get(base + word * 4 + i);
        bytesInWord.push(value);
        if (value === undefined) {
          ascii.push('.');
        } else if (value >= 0x20 && value <= 0x7E) {
          ascii.push(String.fromCharCode(value));
        } else {
          ascii.push('.');
        }
      }

      if (bytesInWord.some(v => v === undefined)) {
        words.push('........');
      } else {
        words.push(bytesInWord.map(v => toHex(v as number, 2)).join(''));
      }
    }

    result.push({
      address: base,
      words,
      ascii: ascii.join('')
    });
  }

  return result;
}

function getWebviewContent(rows: DumpRow[], title: string): string {
  const rowsJson = JSON.stringify(rows);
  const titleJson = JSON.stringify(title);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      font-family: Consolas, 'Courier New', monospace;
      font-size: 13px;
      margin: 0;
      padding: 0;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
    }
    .container {
      padding: 8px 12px 24px;
      width: max-content;
    }
    .title-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 0;
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
      z-index: 3;
      padding: 6px 0;
      flex-wrap: wrap;
    }
    .title {
      font-weight: bold;
      white-space: nowrap;
    }
    .goto {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .goto input {
      width: 12ch;
      padding: 2px 6px;
      font-family: inherit;
      font-size: 12px;
      border: 1px solid var(--vscode-editorGroup-border);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
    }
    .goto button {
      padding: 2px 8px;
      font-size: 12px;
      border: 1px solid var(--vscode-editorGroup-border);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
    }
    .header-line {
      position: sticky;
      top: 40px;
      background: var(--vscode-editor-background);
      z-index: 2;
      padding: 2px 8px;
      font-weight: bold;
      white-space: pre;
    }
    table {
      border-collapse: collapse;
      width: max-content;
      table-layout: fixed;
      display: inline-table;
      margin-top: 0;
    }
    tbody td {
      padding: 2px 8px;
      white-space: pre;
    }
    tr.flash td {
      background: rgba(255, 215, 0, 0.25);
    }
    td.address {
      color: #FF8C00;
      font-weight: bold;
      width: 10ch;
    }
    td.word {
      width: 10ch;
    }
    td.word input {
      width: 8ch;
      background: transparent;
      border: 1px solid transparent;
      color: var(--vscode-editor-foreground);
      font-family: inherit;
      font-size: inherit;
      padding: 1px 2px;
      text-transform: uppercase;
    }
    td.word input:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-editor-selectionBackground);
    }
    td.ascii {
      color: #00AA00;
      font-weight: bold;
      padding-left: 12px;
      width: 16ch;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="title-bar">
      <div class="goto">
        <input id="goto-input" placeholder="0x70010000" />
        <button id="goto-btn">Go</button>
      </div>
    </div>
    <div class="header-line">ADDRESS         0        4        8        C        ASCII</div>
    <table>
      <tbody id="dump-body"></tbody>
    </table>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const rows = ${rowsJson};

    function render(rowsData) {
      const tbody = document.getElementById('dump-body');
      tbody.innerHTML = '';

      for (const row of rowsData) {
        const tr = document.createElement('tr');
        tr.id = 'addr-' + row.address.toString(16).toUpperCase().padStart(8, '0');
        tr.setAttribute('data-address', row.address.toString());

        const addr = document.createElement('td');
        addr.className = 'address';
        addr.textContent = row.address.toString(16).toUpperCase().padStart(8, '0');
        tr.appendChild(addr);

        for (let i = 0; i < 4; i += 1) {
          const td = document.createElement('td');
          td.className = 'word';
          const input = document.createElement('input');
          input.value = row.words[i];
          input.maxLength = 8;
          input.setAttribute('data-addr', (row.address + i * 4).toString());
          input.addEventListener('blur', handleEdit);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              input.blur();
            }
          });
          td.appendChild(input);
          tr.appendChild(td);
        }

        const ascii = document.createElement('td');
        ascii.className = 'ascii';
        ascii.textContent = row.ascii;
        tr.appendChild(ascii);

        tbody.appendChild(tr);
      }
    }


    function handleEdit(event) {
      const input = event.target;
      const value = input.value.trim().toUpperCase();
      if (!/^[0-9A-F]{8}$/.test(value)) {
        input.value = input.value;
        return;
      }
      const addr = parseInt(input.getAttribute('data-addr'), 10);
      vscode.postMessage({ type: 'editWord', address: addr, value });
    }

    function goToAddress(raw) {
      if (!raw) return;
      const cleaned = raw.trim().toLowerCase().startsWith('0x') ? raw.trim().slice(2) : raw.trim();
      const addr = parseInt(cleaned, 16);
      if (!Number.isFinite(addr)) return;
      const addrHex = addr.toString(16).toUpperCase().padStart(8, '0');
      const row = document.getElementById('addr-' + addrHex);
      if (row) {
        row.scrollIntoView({ block: 'center' });
        row.classList.add('flash');
        setTimeout(() => row.classList.remove('flash'), 800);
      }
    }

    render(rows);
    document.getElementById('goto-btn').addEventListener('click', () => {
      const value = document.getElementById('goto-input').value;
      goToAddress(value);
    });
    document.getElementById('goto-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        goToAddress(e.target.value);
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'update') {
        render(message.rows);
      }
      if (message.type === 'goToAddress') {
        goToAddress(message.address.toString(16));
      }
    });
  </script>
</body>
</html>`;
}

class TaskingHexCustomEditor implements vscode.CustomTextEditorProvider {
  private readonly context: vscode.ExtensionContext;
  private applying = false;
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private lastPanel: vscode.WebviewPanel | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true };
    const docKey = document.uri.toString();
    this.panels.set(docKey, webviewPanel);
    this.lastPanel = webviewPanel;

    const updateWebview = () => {
      const bytes = parseIntelHex(document.getText());
      const rows = toDumpRows(bytes);
      webviewPanel.webview.html = getWebviewContent(rows, document.fileName);
    };

    updateWebview();

    const changeDocSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (this.applying) return;
      const bytes = parseIntelHex(document.getText());
      const rows = toDumpRows(bytes);
      webviewPanel.webview.postMessage({ type: 'update', rows });
    });

    webviewPanel.onDidDispose(() => {
      changeDocSubscription.dispose();
      this.panels.delete(docKey);
      if (this.lastPanel === webviewPanel) {
        this.lastPanel = null;
      }
    });

    webviewPanel.webview.onDidReceiveMessage(async message => {
      if (message.type !== 'editWord') return;

      const addr = Number(message.address);
      const value = String(message.value || '').toUpperCase();
      if (!Number.isFinite(addr) || !/^[0-9A-F]{8}$/.test(value)) return;

      const bytes = parseIntelHex(document.getText());
      const newBytes: number[] = [];
      for (let i = 0; i < 8; i += 2) {
        newBytes.push(parseInt(value.slice(i, i + 2), 16));
      }

      for (let i = 0; i < 4; i += 1) {
        bytes.set(addr + i, newBytes[i]);
      }

      const newHex = buildIntelHex(bytes);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
      ), newHex);

      this.applying = true;
      await vscode.workspace.applyEdit(edit);
      await document.save();
      this.applying = false;

      const updatedBytes = parseIntelHex(document.getText());
      const updatedRows = toDumpRows(updatedBytes);
      webviewPanel.webview.postMessage({ type: 'update', rows: updatedRows });
    });
  }

  getPanelForUri(uri?: vscode.Uri): vscode.WebviewPanel | null {
    if (uri) {
      const panel = this.panels.get(uri.toString());
      if (panel) return panel;
    }
    return this.lastPanel;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new TaskingHexCustomEditor(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'taskingHex.dumpEditor',
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
}

export function deactivate() {}
