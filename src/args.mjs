export function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  const positionals = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      // Terminador: todo o restante é posicional.
      positionals.push(...tokens.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const equalsIndex = key.indexOf("=");
    if (equalsIndex !== -1) {
      options[key.slice(0, equalsIndex)] = key.slice(equalsIndex + 1);
      continue;
    }
    const next = tokens[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }

  return { command, options, positionals };
}

export function parseBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true) return true;
  if (["true", "1", "yes", "sim"].includes(String(value).toLowerCase())) return true;
  if (["false", "0", "no", "nao", "não"].includes(String(value).toLowerCase())) return false;
  throw new Error(`Valor booleano inválido: ${value}`);
}
