#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

bash -n "$ROOT/_lib.sh" "$ROOT/start-all.sh" "$ROOT/start-memory-core.sh" "$ROOT/start-proxy.sh"

python3 - "$ROOT" <<'PY'
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
# Escaneo acotado a los scripts que este hardening mantiene; start-all-mongo.sh
# es archivo upstream con entrante #1292 — no se escanea para no crear conflicto.
owned = ["_lib.sh", "start-all.sh", "start-memory-core.sh", "start-proxy.sh"]
findings = []
for name in owned:
    path = root / name
    for number, line in enumerate(path.read_text().splitlines(), 1):
        for match in re.finditer(r"\$([A-Za-z_][A-Za-z0-9_]*)([^\x00-\x7f])", line):
            findings.append(
                f"{path.name}:{number}: ${match.group(1)} followed by U+{ord(match.group(2)):04X}"
            )
if findings:
    raise SystemExit("BLOQ: expansiones sin llaves junto a Unicode:\n" + "\n".join(findings))
PY

grep -F 'prompt_secret_with_default "memory 组 LLM API_KEY"' "$ROOT/_lib.sh" >/dev/null
grep -F 'prompt_secret_with_default "proxy 组 UPSTREAM_API_KEY"' "$ROOT/_lib.sh" >/dev/null
grep -F 'chmod 600 "$ENV_FILE"' "$ROOT/start-all.sh" >/dev/null
grep -F 'serviceToken: "${MEMORY_CORE_GATEWAY_API_KEY}"' "$ROOT/start-proxy.sh" >/dev/null
grep -F 'prepare_secret_file "$CONFIG_DIR" "$CONFIG_FILE"' "$ROOT/start-proxy.sh" >/dev/null
grep -F 'prepare_secret_file "$CORE_CONFIG_DIR" "$CORE_CONFIG_FILE"' "$ROOT/start-memory-core.sh" >/dev/null

if grep -F "export ANTHROPIC_AUTH_TOKEN='\${ADMIN_KEY}'" "$ROOT/start-all.sh" >/dev/null; then
  echo "BLOQ: start-all.sh todavía imprime la admin key." >&2
  exit 1
fi

# Prueba funcional del wiring: ejecutar start-proxy con Docker simulado y
# validar el YAML resultante, incluida la preservación del valor vacío/no vacío.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/deploy" "$TMP/bin" "$TMP/config"
cp "$ROOT/_lib.sh" "$ROOT/start-proxy.sh" "$TMP/deploy/"
cat > "$TMP/bin/docker" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "ps" ]]; then
  printf 'tdai-memory-core\ntdai-memory-hub\n'
elif [[ "${1:-}" == "inspect" ]]; then
  if [[ "$*" == *'.State.Status'* ]]; then printf 'running\n'; else printf 'healthy\n'; fi
fi
exit 0
EOF
chmod +x "$TMP/bin/docker"
cat > "$TMP/deploy/.env" <<EOF
PROXY_IMAGE=test/proxy:local
PROXY_PORT=18096
PROXY_UPSTREAM_URL=http://upstream.invalid
PROXY_UPSTREAM_API_KEY=test-upstream-key
PROXY_UPSTREAM_MODEL=test-model
MEMORY_CORE_GATEWAY_API_KEY=test-gateway-key
PROXY_CONFIG_DIR=$TMP/config
EOF
chmod 600 "$TMP/deploy/.env"
PATH="$TMP/bin:$PATH" "$TMP/deploy/start-proxy.sh" >/dev/null
ruby -e 'require "yaml"; c=YAML.safe_load(File.read(ARGV[0])); abort unless c.dig("auth","serviceToken")=="test-gateway-key" && c.dig("tdai","apiKey")=="test-gateway-key" && c.dig("skill","serviceToken")=="test-gateway-key"' "$TMP/config/config.yaml"
[[ "$(stat -f %Lp "$TMP/config")" == "700" ]]
[[ "$(stat -f %Lp "$TMP/config/config.yaml")" == "600" ]]

# Un valor explícitamente vacío debe conservarse vacío en los tres canales.
PATH="$TMP/bin:$PATH" ENV_FILE="$TMP/deploy/.env" bash -c 'source "$1"; set_env_value MEMORY_CORE_GATEWAY_API_KEY "" "$2"' _ "$TMP/deploy/_lib.sh" "$TMP/deploy/.env"
PATH="$TMP/bin:$PATH" "$TMP/deploy/start-proxy.sh" >/dev/null
ruby -e 'require "yaml"; c=YAML.safe_load(File.read(ARGV[0])); abort unless c.dig("auth","serviceToken")=="" && c.dig("tdai","apiKey")=="" && c.dig("skill","serviceToken")==""' "$TMP/config/config.yaml"

# set_env_value crea desde cero con 0600, restaura umask y rechaza symlinks.
PATH="$TMP/bin:$PATH" ENV_FILE="$TMP/deploy/.env" bash -c 'umask 022; before=$(umask); source "$1"; set_env_value SAMPLE value "$2"; [[ "$(umask)" == "$before" ]]' _ "$TMP/deploy/_lib.sh" "$TMP/env-under-test"
[[ "$(stat -f %Lp "$TMP/env-under-test")" == "600" ]]
printf 'intacto\n' > "$TMP/env-target"
ln -s "$TMP/env-target" "$TMP/env-link"
if PATH="$TMP/bin:$PATH" ENV_FILE="$TMP/deploy/.env" bash -c 'source "$1"; set_env_value SAMPLE value "$2"' _ "$TMP/deploy/_lib.sh" "$TMP/env-link" >/dev/null 2>&1; then
  echo "BLOQ: set_env_value aceptó un symlink." >&2
  exit 1
fi
[[ "$(cat "$TMP/env-target")" == "intacto" ]]

# El helper común protege configuraciones generadas aun con umask permisivo.
PATH="$TMP/bin:$PATH" ENV_FILE="$TMP/deploy/.env" bash -c 'umask 022; before=$(umask); source "$1"; prepare_secret_file "$2" "$2/secret.yaml"; [[ "$(umask)" == "$before" ]]' _ "$TMP/deploy/_lib.sh" "$TMP/fresh-config"
[[ "$(stat -f %Lp "$TMP/fresh-config")" == "700" ]]
[[ "$(stat -f %Lp "$TMP/fresh-config/secret.yaml")" == "600" ]]

echo "OK: shell safety (Unicode, secrets, permisos y Bearer) verificado."
