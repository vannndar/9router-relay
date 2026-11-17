function eventData(event) {
  const lines = event.split('\n').filter((line) => line.startsWith('data:'));
  return lines.length ? lines.map((line) => line.slice(5).replace(/^ /, '')).join('\n') : null;
}

/** Decode SSE across arbitrary network/UTF-8 boundaries, including a final unterminated event. */
export async function* readSseData(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const data = eventData(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (data !== null) yield data;
      }
      if (done) {
        finished = true;
        const data = eventData(buffer);
        if (data !== null) yield data;
        break;
      }
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
