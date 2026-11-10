# Instala AlchemyCut en Windows (no pide permisos de administrador).
#   - copia el panel a la carpeta de extensiones CEP del usuario
#   - habilita las extensiones sin firmar de Adobe (PlayerDebugMode) para CSXS 9 a 12
# Uso: clic derecho > "Ejecutar con PowerShell", o doble clic en instalar-windows.bat
# Opciones:  -Link  enlaza esta carpeta en vez de copiarla (para desarrollo)   -Uninstall  lo desinstala
param([switch]$Link, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'

$src  = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$dest = Join-Path $root 'com.adsalchemy.alchemycut'

# borra la carpeta instalada (si es un enlace, quita solo el enlace y no la carpeta original)
function Remove-Installed {
  if (Test-Path $dest) {
    $it = Get-Item $dest -Force
    if ($it.Attributes -band [IO.FileAttributes]::ReparsePoint) { $it.Delete() } else { Remove-Item $dest -Recurse -Force }
  }
}

if ($Uninstall) {
  Remove-Installed
  Write-Host 'AlchemyCut desinstalado. Reinicia Premiere Pro.'
  exit 0
}

New-Item -ItemType Directory -Force -Path $root | Out-Null
Remove-Installed

if ($Link) {
  New-Item -ItemType Junction -Path $dest -Target $src | Out-Null
  Write-Host "Enlazado: $dest -> $src"
} else {
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  # se copia todo menos pruebas y archivos de desarrollo
  Get-ChildItem -LiteralPath $src -Force | Where-Object { $_.Name -notin @('test', '.git', 'install.sh', 'node_modules') } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $dest -Recurse -Force }
  Write-Host "Copiado a: $dest"
}

# Premiere solo abre extensiones sin firmar si esto esta activado
foreach ($v in 9, 10, 11, 12) {
  $key = "HKCU:\Software\Adobe\CSXS.$v"
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  New-ItemProperty -Path $key -Name 'PlayerDebugMode' -Value '1' -PropertyType String -Force | Out-Null
}
Write-Host 'PlayerDebugMode activado (CSXS 9 a 12).'
Write-Host ''
Write-Host 'Listo. Cerra Premiere Pro por completo y abrilo de nuevo.'
Write-Host 'Menu: Ventana > Extensiones > AlchemyCut.'
Write-Host 'La primera vez, el panel te ofrece instalar ffmpeg y Whisper con un boton.'
