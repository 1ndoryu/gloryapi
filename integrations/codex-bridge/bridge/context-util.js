  function preserveCanaryProvider(source, target) {
    if (typeof source.__canaryProvider === 'string') {
      Object.defineProperty(target, '__canaryProvider', {
        value: source.__canaryProvider,
        enumerable: false,
      });
    }
    for (const key of ['__parentRouteId', '__parentConfigurationRevision', '__parentSelectionReason']) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
        Object.defineProperty(target, key, {
          value: source[key],
          enumerable: false,
          configurable: true,
          writable: true,
        });
      }
    }
    return target;
  }

// ¿El turno ACTUAL (desde el último mensaje del usuario) ya ejecutó tools?
// Se conserva para telemetría y compatibilidad con consumidores del adaptador;
// el guard de cierre ya no depende de este dato ni de una frase de intención.
function currentTurnHasToolMessages(messages) {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === 'user') {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return false; // sin user visible, no hay turno que nudgear
  for (let i = lastUser + 1; i < messages.length; i += 1) {
    if (messages[i] && messages[i].role === 'tool') return true;
  }
  return false;
}

function messageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => part && typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n');
}

function latestUserText(messages, preferredText = '') {
  if (typeof preferredText === 'string' && preferredText.trim()) return preferredText;
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === 'user') return messageText(messages[i]);
  }
  return '';
}

// This is intentionally based on the user's request, not on a phrase chosen by
// the model. It avoids paying for an audit on greetings while still auditing
// action-shaped turns that could close after a narration without a tool call.
function isActionOrientedRequest(messages, preferredText = '') {
  const text = latestUserText(messages, preferredText).trim();
  if (!text) return false;
  const unambiguousAction = /\b(abr(e|ir)|actualiza|añade|analiza|arregla|busca|cambia|comprueba|configura|corrige|crea|diagnostica|ejecuta|escribe|inspecciona|instala|lee|lista|muestra|obten|ordena|revisa|repite|resuelve|reinicia|usa|verifica|abre|add|analy[sz]e|build|check|configure|create|diagnose|edit|execute|fix|inspect|install|list|open|read|review|run|search|sort|update|verify)\b/i;
  const directTestCommand = /^(?:(?:hola|buenas|hello|hi)[, ]+)?(?:por favor[, ]+|please\s+)?(?:prueba|test)\b/i;
  return unambiguousAction.test(text) || directTestCommand.test(text);
}

function isUserConfirmationRequest(messages, preferredText = '') {
  const text = latestUserText(messages, preferredText).trim().toLowerCase().replace(/[.!?,;:]+$/g, '');
  return /^(ok|okay|vale|listo|ya está|ya esta|terminaste|terminó|termino|eso es todo|nada más|nada mas)$/.test(text);
}

module.exports = { preserveCanaryProvider, latestUserText, isActionOrientedRequest, isUserConfirmationRequest, currentTurnHasToolMessages };
