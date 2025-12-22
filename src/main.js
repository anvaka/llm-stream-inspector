import { parseSSEStream } from './parser.js';
import './style.css';

const inputEl = document.getElementById('sse-input');
const outputEl = document.getElementById('output');
const metadataEl = document.getElementById('metadata');
const errorsEl = document.getElementById('errors');
const clearBtn = document.getElementById('clear-btn');
const copyBtn = document.getElementById('copy-btn');
const lineNumbersEl = document.getElementById('line-numbers');

let currentContent = '';

function formatProvider(provider) {
  const names = {
    'openai': 'OpenAI',
    'anthropic': 'Anthropic',
    'google': 'Google',
    'unknown': 'Unknown'
  };
  return names[provider] || provider;
}

function renderMetadata(metadata) {
  if (!metadata) {
    metadataEl.classList.add('hidden');
    return;
  }
  
  const parts = [];
  
  parts.push(`<span><strong>Provider:</strong> ${formatProvider(metadata.provider)}</span>`);
  
  if (metadata.model) {
    parts.push(`<span><strong>Model:</strong> ${escapeHtml(metadata.model)}</span>`);
  }
  
  parts.push(`<span><strong>Chunks:</strong> ${metadata.chunkCount}</span>`);
  
  if (metadata.finishReason) {
    parts.push(`<span><strong>Finish:</strong> ${escapeHtml(metadata.finishReason)}</span>`);
  }
  
  metadataEl.innerHTML = parts.join('');
  metadataEl.classList.remove('hidden');
}

function renderErrors(errors) {
  if (!errors || errors.length === 0) {
    errorsEl.classList.add('hidden');
    return;
  }
  
  const maxErrors = 5;
  const displayed = errors.slice(0, maxErrors);
  const remaining = errors.length - maxErrors;
  
  errorsEl.innerHTML = '';
  
  displayed.forEach(err => {
    const errorItem = document.createElement('div');
    errorItem.className = 'error-item';
    
    if (err.line) {
      const lineLink = document.createElement('button');
      lineLink.className = 'error-line-link';
      lineLink.textContent = `Line ${err.line}`;
      lineLink.onclick = () => goToLine(err.line);
      errorItem.appendChild(lineLink);
      
      const msgSpan = document.createElement('span');
      msgSpan.textContent = `: ${err.message}`;
      errorItem.appendChild(msgSpan);
    } else {
      errorItem.textContent = err.message;
    }
    
    errorsEl.appendChild(errorItem);
  });
  
  if (remaining > 0) {
    const moreEl = document.createElement('div');
    moreEl.className = 'error-more';
    moreEl.textContent = `...and ${remaining} more error${remaining > 1 ? 's' : ''}`;
    errorsEl.appendChild(moreEl);
  }
  
  errorsEl.classList.remove('hidden');
}

function goToLine(lineNumber) {
  const text = inputEl.value;
  const lines = text.split('\n');
  
  // Calculate character position of the start of the line
  let charPos = 0;
  for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
    charPos += lines[i].length + 1; // +1 for newline
  }
  
  // Select the entire line
  const lineEnd = charPos + (lines[lineNumber - 1]?.length || 0);
  
  inputEl.focus();
  inputEl.setSelectionRange(charPos, lineEnd);
  
  // Scroll the textarea to show the selected line
  const lineHeight = parseInt(getComputedStyle(inputEl).lineHeight) || 20;
  const scrollTop = (lineNumber - 3) * lineHeight; // Show a few lines above
  inputEl.scrollTop = Math.max(0, scrollTop);
  
  // Highlight the line number
  highlightLineNumber(lineNumber);
}

function highlightLineNumber(lineNumber) {
  const lineEls = lineNumbersEl.querySelectorAll('.line-num');
  lineEls.forEach(el => el.classList.remove('highlighted'));
  
  const targetEl = lineEls[lineNumber - 1];
  if (targetEl) {
    targetEl.classList.add('highlighted');
    setTimeout(() => targetEl.classList.remove('highlighted'), 2000);
  }
}

function renderOutput(content) {
  currentContent = content;
  
  if (!content) {
    outputEl.innerHTML = '<span class="placeholder">Output will appear here</span>';
    return;
  }
  
  outputEl.textContent = content;
}

function updateLineNumbers() {
  const text = inputEl.value;
  const lineCount = text ? text.split('\n').length : 1;
  
  // Only update if line count changed
  const currentLineCount = lineNumbersEl.children.length;
  if (currentLineCount === lineCount) return;
  
  const fragment = document.createDocumentFragment();
  for (let i = 1; i <= lineCount; i++) {
    const lineEl = document.createElement('div');
    lineEl.className = 'line-num';
    lineEl.textContent = i;
    fragment.appendChild(lineEl);
  }
  
  lineNumbersEl.innerHTML = '';
  lineNumbersEl.appendChild(fragment);
}

function syncScroll() {
  lineNumbersEl.scrollTop = inputEl.scrollTop;
}

function processInput() {
  const raw = inputEl.value;
  
  if (!raw.trim()) {
    renderMetadata(null);
    renderErrors(null);
    renderOutput('');
    return;
  }
  
  const result = parseSSEStream(raw);
  
  renderMetadata(result.metadata);
  renderErrors(result.errors);
  renderOutput(result.content);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Debounce for performance with large inputs
function debounce(fn, delay) {
  let timeoutId;
  return function (...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), delay);
  };
}

const debouncedProcess = debounce(processInput, 150);

// Event listeners
inputEl.addEventListener('input', () => {
  updateLineNumbers();
  debouncedProcess();
});

inputEl.addEventListener('scroll', syncScroll);

clearBtn.addEventListener('click', () => {
  inputEl.value = '';
  updateLineNumbers();
  renderMetadata(null);
  renderErrors(null);
  renderOutput('');
  inputEl.focus();
});

copyBtn.addEventListener('click', async () => {
  if (!currentContent) return;
  
  try {
    await navigator.clipboard.writeText(currentContent);
    
    const originalText = copyBtn.textContent;
    copyBtn.textContent = 'Copied';
    setTimeout(() => {
      copyBtn.textContent = originalText;
    }, 1500);
  } catch {
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = currentContent;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    
    const originalText = copyBtn.textContent;
    copyBtn.textContent = 'Copied';
    setTimeout(() => {
      copyBtn.textContent = originalText;
    }, 1500);
  }
});

// Process on page load if there's existing content (e.g., from browser autofill)
updateLineNumbers();
if (inputEl.value) {
  processInput();
}
