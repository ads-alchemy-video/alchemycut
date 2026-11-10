#!/usr/bin/env bash
# Publica una versión nueva en GitHub (Releases). Los editores la reciben con el botón "Actualizar" del panel.
#   ./publicar.sh 1.2.0 "Qué cambió, en una frase"
#   ./publicar.sh 1.2.0 "notas" --solo-local     arma todo en dist/ pero no publica (para probar)
# Hace: sube el número de versión, arma los zips, calcula su huella (SHA-256), escribe dist/version.json
#       y crea el Release con los zips y version.json.
set -euo pipefail
cd "$(dirname "$0")"
VER="${1:-}"; NOTES="${2:-}"; LOCAL=0
[ "${3:-}" = "--solo-local" ] && LOCAL=1
if ! [[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "Uso: ./publicar.sh 1.2.0 \"notas\"   (la versión tiene tres números: 1.2.0)"; exit 1; fi

# repositorio: el que tenga version.json, o el de git
REPO="$(python3 -c "import json;print(json.load(open('version.json')).get('repo',''))")"
if [ "$REPO" = "" ] || [[ "$REPO" == PENDIENTE* ]]; then
  REPO="$(git remote get-url origin 2>/dev/null | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
fi
if ! [[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then echo "No sé cuál es el repositorio de GitHub. Corré el script de primera vez (git remote origin) o editá version.json."; exit 1; fi

# 1) versión nueva en version.json y en el manifest de Premiere
python3 - "$VER" "$REPO" <<'PY'
import json,re,sys
ver,repo=sys.argv[1],sys.argv[2]
open('version.json','w').write(json.dumps({"version":ver,"repo":repo},indent=2)+"\n")
m=open('CSXS/manifest.xml').read()
m=re.sub(r'ExtensionBundleVersion="[^"]*"','ExtensionBundleVersion="%s"'%ver,m,1)
m=re.sub(r'(<Extension Id="com\.adsalchemy\.alchemycut\.panel" Version=")[^"]*(" />)',r'\g<1>%s\2'%ver,m,1)
open('CSXS/manifest.xml','w').write(m)
PY

# 2) zips
./empaquetar.sh > /dev/null

# 3) version.json del release (con la huella de cada zip)
python3 - "$VER" "$NOTES" <<'PY'
import hashlib,json,os,sys
ver,notes=sys.argv[1],sys.argv[2]
def info(n):
    p='dist/'+n; b=open(p,'rb').read()
    return {"name":n,"sha256":hashlib.sha256(b).hexdigest(),"size":len(b)}
out={"version":ver,"notes":notes,"assets":{"windows":info('AlchemyCut-Windows.zip'),"mac":info('AlchemyCut-Mac.zip')}}
open('dist/version.json','w').write(json.dumps(out,indent=2,ensure_ascii=False)+"\n")
print(json.dumps(out,indent=2,ensure_ascii=False))
PY

if [ "$LOCAL" = "1" ]; then echo "Listo en dist/ (no se publicó)."; exit 0; fi

# 4) publicar
gh release create "v$VER" dist/AlchemyCut-Windows.zip dist/AlchemyCut-Mac.zip dist/version.json \
  --repo "$REPO" --title "AlchemyCut $VER" --notes "${NOTES:-AlchemyCut $VER}" --latest
echo "Publicado: https://github.com/$REPO/releases/tag/v$VER"
