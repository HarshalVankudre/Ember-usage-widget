# Renders the Ember mark (incandescent E) to src-tauri/icons/icon.ico and
# src-tauri/icons/tray.png. Pure GDI+ — no Electron, no npm deps.
# Master art: src/assets/logo.svg (this script mirrors its geometry).

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconsDir = Join-Path $root 'src-tauri\icons'
New-Item -ItemType Directory -Force $iconsDir | Out-Null

function New-RoundedRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-EmberBrush {
  # gold -> ember gradient across the E (design space y 14..50)
  $b = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.PointF(0, 14)),
    (New-Object System.Drawing.PointF(0, 50)),
    [System.Drawing.Color]::FromArgb(255, 255, 209, 102),
    [System.Drawing.Color]::FromArgb(255, 255, 95, 46))
  $blend = New-Object System.Drawing.Drawing2D.ColorBlend(3)
  $blend.Colors = @(
    [System.Drawing.Color]::FromArgb(255, 255, 209, 102),
    [System.Drawing.Color]::FromArgb(255, 255, 141, 74),
    [System.Drawing.Color]::FromArgb(255, 255, 95, 46))
  $blend.Positions = @([float]0, [float]0.55, [float]1)
  $b.InterpolationColors = $blend
  return $b
}

function Draw-E([System.Drawing.Graphics]$g) {
  $brush = New-EmberBrush
  foreach ($bar in @(
      @(19, 14, 8, 36),   # spine
      @(19, 14, 27, 8),   # top arm
      @(19, 28, 22, 8),   # middle arm
      @(19, 42, 27, 8)    # bottom arm
    )) {
    $path = New-RoundedRect $bar[0] $bar[1] $bar[2] $bar[3] 4
    $g.FillPath($brush, $path)
    $path.Dispose()
  }
  $brush.Dispose()
}

function Render-Badge([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $s = $size / 64.0
  $g.ScaleTransform($s, $s)
  $badge = New-RoundedRect 3 3 58 58 15
  $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 22, 14, 8))
  $g.FillPath($bg, $badge)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(41, 255, 160, 92), (1.2 / $s))
  $g.DrawPath($pen, $badge)
  Draw-E $g
  $pen.Dispose(); $bg.Dispose(); $badge.Dispose(); $g.Dispose()
  return $bmp
}

function Render-Tray([int]$size) {
  # glyph only, transparent background, 3px breathing room
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $scale = ($size - 6) / 36.0
  $ox = ($size - 27 * $scale) / 2 - 19 * $scale
  $oy = ($size - 36 * $scale) / 2 - 14 * $scale
  $g.TranslateTransform($ox, $oy)
  $g.ScaleTransform($scale, $scale)
  Draw-E $g
  $g.Dispose()
  return $bmp
}

function Get-PngBytes([System.Drawing.Bitmap]$bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  return $bytes
}

function Get-DibBytes([System.Drawing.Bitmap]$bmp) {
  # Classic ICO payload: BITMAPINFOHEADER + bottom-up BGRA pixels + AND mask.
  # Explorer and .NET both accept PNG only for the 256px slot.
  $size = $bmp.Width
  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $data = $bmp.LockBits($rect, 'ReadOnly', [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $pixels = New-Object byte[] ($stride * $size)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixels, 0, $pixels.Length)
  $bmp.UnlockBits($data)

  $maskRow = [int](([math]::Ceiling($size / 32.0)) * 4)
  $ms = New-Object System.IO.MemoryStream
  $w = New-Object System.IO.BinaryWriter($ms)
  $w.Write([uint32]40)                    # BITMAPINFOHEADER
  $w.Write([int32]$size)
  $w.Write([int32]($size * 2))            # XOR + AND heights
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]0)                     # BI_RGB
  $w.Write([uint32]($size * $size * 4 + $maskRow * $size))
  $w.Write([int32]0); $w.Write([int32]0); $w.Write([uint32]0); $w.Write([uint32]0)
  for ($y = $size - 1; $y -ge 0; $y--) {  # bottom-up rows
    $w.Write($pixels, $y * $stride, $size * 4)
  }
  $w.Write((New-Object byte[] ($maskRow * $size)))  # empty AND mask (alpha rules)
  $bytes = $ms.ToArray()
  $w.Dispose(); $ms.Dispose()
  return $bytes
}

# --- icon.ico: DIB entries, PNG for the 256px slot, largest first ---
$sizes = 256, 128, 64, 48, 32, 24, 16
$images = @()
foreach ($size in $sizes) {
  $bmp = Render-Badge $size
  $bytes = if ($size -ge 256) { Get-PngBytes $bmp } else { Get-DibBytes $bmp }
  $images += , @($size, $bytes)
  $bmp.Dispose()
}

$icoPath = Join-Path $iconsDir 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$w = New-Object System.IO.BinaryWriter($fs)
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($img in $images) {
  $size = $img[0]; $bytes = $img[1]
  $w.Write([byte]($(if ($size -ge 256) { 0 } else { $size })))
  $w.Write([byte]($(if ($size -ge 256) { 0 } else { $size })))
  $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$bytes.Length); $w.Write([uint32]$offset)
  $offset += $bytes.Length
}
foreach ($img in $images) {
  $blob = [byte[]]$img[1]
  $w.Write($blob, 0, $blob.Length)
}
$w.Dispose(); $fs.Dispose()

# sanity: every declared size must load back as an icon
foreach ($size in $sizes) {
  $probe = New-Object System.Drawing.Icon($icoPath, $size, $size)
  $probe.Dispose()
}

# --- tray.png ---
$tray = Render-Tray 32
$tray.Save((Join-Path $iconsDir 'tray.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$tray.Dispose()

Write-Output "wrote $icoPath ($($images.Count) sizes) and tray.png"
