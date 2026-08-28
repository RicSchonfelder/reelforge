import fs from "node:fs";

/**
 * Lê um arquivo JSON tolerando corrupção: em vez de derrubar todas as rotas,
 * o arquivo ruim é colocado em quarentena (`<arquivo>.corrupt-<timestamp>`)
 * e o chamador recebe null para reconstruir o estado inicial.
 */
export function readJsonOrQuarantine(filePath) {
  if (!fs.existsSync(filePath)) return { value: null, recovered: false };
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return { value: null, recovered: false };
  }
  try {
    return { value: JSON.parse(text), recovered: false };
  } catch {
    try {
      fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    } catch {
      // se nem a quarentena for possível, segue como arquivo ausente
    }
    return { value: null, recovered: true };
  }
}

/**
 * Valida o estado lido; se o formato não for o esperado, o arquivo também
 * vai para quarentena (evita loop permanente com um JSON válido porém incompatível).
 */
export function quarantineIfInvalid(filePath, value, isValid) {
  if (value !== null && isValid(value)) return value;
  if (value !== null) {
    try {
      fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    } catch {
      // segue com estado inicial
    }
  }
  return null;
}
