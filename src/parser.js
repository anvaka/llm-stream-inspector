/**
 * Parse SSE stream data and extract content from various LLM providers
 */

/**
 * Detects the provider format from a parsed JSON chunk
 */
function detectProvider(data) {
  if (!data || typeof data !== 'object') return 'unknown';
  
  // OpenAI format: has choices array with delta
  if (data.choices && Array.isArray(data.choices)) {
    return 'openai';
  }
  
  // Anthropic Claude format: has type field like 'content_block_delta'
  if (data.type && typeof data.type === 'string') {
    if (data.type.includes('content_block') || data.type.includes('message')) {
      return 'anthropic';
    }
  }
  
  // Google Gemini format: has candidates array
  if (data.candidates && Array.isArray(data.candidates)) {
    return 'google';
  }
  
  return 'unknown';
}

/**
 * Extract content from a single parsed chunk based on provider
 */
function extractContent(data, provider) {
  try {
    switch (provider) {
      case 'openai':
        return extractOpenAIContent(data);
      case 'anthropic':
        return extractAnthropicContent(data);
      case 'google':
        return extractGoogleContent(data);
      default:
        return extractGenericContent(data);
    }
  } catch {
    return '';
  }
}

function extractOpenAIContent(data) {
  const choice = data.choices?.[0];
  if (!choice) return '';
  
  // Handle delta format (streaming)
  if (choice.delta?.content) {
    return choice.delta.content;
  }
  
  // Handle message format (non-streaming)
  if (choice.message?.content) {
    return choice.message.content;
  }
  
  return '';
}

function extractAnthropicContent(data) {
  // Content block delta
  if (data.type === 'content_block_delta' && data.delta?.text) {
    return data.delta.text;
  }
  
  // Content block start with text
  if (data.type === 'content_block_start' && data.content_block?.text) {
    return data.content_block.text;
  }
  
  return '';
}

function extractGoogleContent(data) {
  const candidate = data.candidates?.[0];
  if (!candidate) return '';
  
  const parts = candidate.content?.parts;
  if (Array.isArray(parts)) {
    return parts.map(p => p.text || '').join('');
  }
  
  return '';
}

function extractGenericContent(data) {
  // Try common content paths
  const paths = [
    ['content'],
    ['text'],
    ['chunk'],
    ['delta', 'content'],
    ['delta', 'text'],
    ['message', 'content'],
    ['choices', 0, 'delta', 'content'],
    ['choices', 0, 'text'],
  ];
  
  for (const path of paths) {
    const value = getNestedValue(data, path);
    if (typeof value === 'string') {
      return value;
    }
  }
  
  return '';
}

function getNestedValue(obj, path) {
  let current = obj;
  for (const key of path) {
    if (current == null) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Extract metadata from parsed chunks
 */
function extractMetadata(chunks, provider) {
  const metadata = {
    provider: provider,
    model: null,
    id: null,
    chunkCount: chunks.length,
    finishReason: null
  };
  
  for (const data of chunks) {
    if (!data || typeof data !== 'object') continue;
    
    // Model
    if (!metadata.model) {
      metadata.model = data.model || data.message?.model || null;
    }
    
    // ID
    if (!metadata.id) {
      metadata.id = data.id || data.message?.id || null;
    }
    
    // Finish reason
    if (provider === 'openai' && data.choices?.[0]?.finish_reason) {
      metadata.finishReason = data.choices[0].finish_reason;
    }
    if (provider === 'anthropic' && data.type === 'message_stop') {
      metadata.finishReason = 'stop';
    }
    if (provider === 'anthropic' && data.delta?.stop_reason) {
      metadata.finishReason = data.delta.stop_reason;
    }
  }
  
  return metadata;
}

/**
 * Parse raw SSE text input
 * Returns { content, metadata, errors }
 */
export function parseSSEStream(rawInput) {
  const errors = [];
  const chunks = [];
  let detectedProvider = null;
  
  if (!rawInput || typeof rawInput !== 'string') {
    return {
      content: '',
      metadata: null,
      errors: ['No input provided']
    };
  }
  
  // Split by lines first
  const lines = rawInput.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    
    // Skip empty lines (but preserve for line counting)
    if (!line.trim()) continue;
    
    // Handle lines that may contain multiple "data:" entries
    // Split by "data:" but keep track of positions
    const dataEntries = extractDataEntries(line);
    
    for (const entry of dataEntries) {
      const jsonStr = entry.trim();
      
      // Skip [DONE] marker
      if (jsonStr === '[DONE]') continue;
      
      // Skip empty data
      if (!jsonStr) continue;
      
      // Skip event/id/retry prefixes
      if (jsonStr.startsWith('event:') || 
          jsonStr.startsWith('id:') || 
          jsonStr.startsWith('retry:')) continue;
      
      const parseResult = tryParseJSON(jsonStr);
      
      if (parseResult.success) {
        chunks.push(parseResult.data);
        
        // Detect provider from first valid chunk
        if (!detectedProvider) {
          detectedProvider = detectProvider(parseResult.data);
        }
      } else if (jsonStr.startsWith('{')) {
        // Only report error if it looks like JSON
        errors.push({
          line: lineNum,
          message: `Invalid JSON - ${truncate(jsonStr, 40)}`,
          raw: jsonStr
        });
      }
    }
    
    // Also try parsing raw JSON lines (some formats don't use data: prefix)
    if (!line.includes('data:') && line.trim().startsWith('{')) {
      const parseResult = tryParseJSON(line.trim());
      if (parseResult.success) {
        chunks.push(parseResult.data);
        if (!detectedProvider) {
          detectedProvider = detectProvider(parseResult.data);
        }
      }
    }
  }
  
  // Extract content from all successfully parsed chunks (best effort)
  const provider = detectedProvider || 'unknown';
  const contentParts = chunks.map(chunk => extractContent(chunk, provider));
  const content = contentParts.join('');
  
  // Extract metadata
  const metadata = chunks.length > 0 ? extractMetadata(chunks, provider) : null;
  
  // If no chunks but we have errors, still return what we found
  if (chunks.length === 0 && errors.length === 0) {
    return {
      content: '',
      metadata: null,
      errors: [{ line: null, message: 'No valid SSE data found', raw: null }]
    };
  }
  
  return {
    content,
    metadata,
    errors: errors.length > 0 ? errors : null
  };
}

/**
 * Extract all data: entries from a line (handles multiple on same line)
 */
function extractDataEntries(line) {
  const entries = [];
  const dataPrefix = 'data:';
  
  // Find all "data:" occurrences
  let pos = 0;
  while (pos < line.length) {
    const dataStart = line.indexOf(dataPrefix, pos);
    if (dataStart === -1) break;
    
    const contentStart = dataStart + dataPrefix.length;
    
    // Find where this data entry ends (next "data:" or end of line)
    const nextData = line.indexOf(dataPrefix, contentStart);
    const entryEnd = nextData === -1 ? line.length : nextData;
    
    entries.push(line.slice(contentStart, entryEnd));
    pos = entryEnd;
  }
  
  return entries;
}

/**
 * Try to parse JSON, returning success/failure with data
 */
function tryParseJSON(str) {
  try {
    const data = JSON.parse(str);
    return { success: true, data };
  } catch {
    return { success: false, data: null };
  }
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}
