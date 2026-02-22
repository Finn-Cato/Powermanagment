Add-Type -AssemblyName System.Drawing

function Make-Image([int]$w, [int]$h, [string]$outFile) {
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

    # Dark background
    $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 28, 28, 32))
    $g.FillRectangle($bg, 0, 0, $w, $h)

    [float]$cx = $w / 2.0
    [float]$cy = $h / 2.0 - 20
    [float]$sc = [Math]::Min($w, $h) / 130.0

    # Glow behind shield
    $glow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(30, 232, 68, 26))
    [float]$gr = 55.0 * $sc
    $g.FillEllipse($glow, ($cx - $gr), ($cy - $gr), ($gr * 2), ($gr * 2))

    # Shield points
    [float]$s42 = 42.0 * $sc
    [float]$s36 = 36.0 * $sc
    [float]$s34 = 34.0 * $sc
    [float]$s28 = 28.0 * $sc
    [float]$s20 = 20.0 * $sc
    [float]$s30 = 30.0 * $sc
    [float]$s10 = 10.0 * $sc

    $shieldPts = [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF($cx, ($cy - $s42))),
        (New-Object System.Drawing.PointF(($cx + $s36), ($cy - $s28))),
        (New-Object System.Drawing.PointF(($cx + $s34), ($cy + $s10))),
        (New-Object System.Drawing.PointF(($cx + $s20), ($cy + $s30))),
        (New-Object System.Drawing.PointF($cx, ($cy + $s42))),
        (New-Object System.Drawing.PointF(($cx - $s20), ($cy + $s30))),
        (New-Object System.Drawing.PointF(($cx - $s34), ($cy + $s10))),
        (New-Object System.Drawing.PointF(($cx - $s36), ($cy - $s28)))
    )

    # Shield gradient
    $sBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF($cx, ($cy - $s42))),
        (New-Object System.Drawing.PointF($cx, ($cy + $s42))),
        [System.Drawing.Color]::FromArgb(255, 255, 107, 53),
        [System.Drawing.Color]::FromArgb(255, 200, 50, 15)
    )
    $sp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $sp.AddPolygon($shieldPts)
    $g.FillPath($sBrush, $sp)

    # Inner shield
    [float]$is = 0.82
    $innerPts = [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF($cx, ($cy - $s42 * $is))),
        (New-Object System.Drawing.PointF(($cx + $s36 * $is), ($cy - $s28 * $is))),
        (New-Object System.Drawing.PointF(($cx + $s34 * $is), ($cy + $s10 * $is))),
        (New-Object System.Drawing.PointF(($cx + $s20 * $is), ($cy + $s30 * $is))),
        (New-Object System.Drawing.PointF($cx, ($cy + $s42 * $is))),
        (New-Object System.Drawing.PointF(($cx - $s20 * $is), ($cy + $s30 * $is))),
        (New-Object System.Drawing.PointF(($cx - $s34 * $is), ($cy + $s10 * $is))),
        (New-Object System.Drawing.PointF(($cx - $s36 * $is), ($cy - $s28 * $is)))
    )
    $iBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF($cx, ($cy - $s42 * $is))),
        (New-Object System.Drawing.PointF($cx, ($cy + $s42 * $is))),
        [System.Drawing.Color]::FromArgb(255, 210, 55, 15),
        [System.Drawing.Color]::FromArgb(255, 170, 40, 10)
    )
    $ip = New-Object System.Drawing.Drawing2D.GraphicsPath
    $ip.AddPolygon($innerPts)
    $g.FillPath($iBrush, $ip)

    # Lightning bolt
    [float]$b4  = 4.0  * $sc; [float]$b6  = 6.0  * $sc; [float]$b10 = 10.0 * $sc
    [float]$b14 = 14.0 * $sc; [float]$b1  = 1.0  * $sc; [float]$b3  = 3.0  * $sc
    [float]$b2  = 2.0  * $sc; [float]$b30 = 30.0 * $sc; [float]$b4n = 4.0  * $sc

    $boltPts = [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF(($cx + $b4), ($cy - $b30))),
        (New-Object System.Drawing.PointF(($cx - $b10), ($cy + $b2))),
        (New-Object System.Drawing.PointF(($cx - $b1), ($cy + $b2))),
        (New-Object System.Drawing.PointF(($cx - $b6), ($cy + $b30))),
        (New-Object System.Drawing.PointF(($cx + $b14), ($cy - $b4n))),
        (New-Object System.Drawing.PointF(($cx + $b3), ($cy - $b4n)))
    )
    $bBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF($cx, ($cy - $b30))),
        (New-Object System.Drawing.PointF($cx, ($cy + $b30))),
        [System.Drawing.Color]::FromArgb(255, 255, 248, 225),
        [System.Drawing.Color]::FromArgb(255, 255, 213, 79)
    )
    $bPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bPath.AddPolygon($boltPts)
    $g.FillPath($bBrush, $bPath)

    # Text "Power Guard"
    [float]$fontSize = 18.0 * $sc
    if ($fontSize -lt 12) { $fontSize = 12 }
    $font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold)
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    [float]$ty = $h - 38.0 * $sc
    $g.DrawString('Power Guard', $font, $textBrush, $cx, $ty, $sf)

    # Subtitle
    [float]$subSize = 8.0 * $sc
    if ($subSize -lt 7) { $subSize = 7 }
    $subFont = New-Object System.Drawing.Font('Segoe UI', $subSize)
    $subBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 255, 255, 255))
    [float]$sty = $ty + $fontSize + 4
    $g.DrawString('Protect your home power limit', $subFont, $subBrush, $cx, $sty, $sf)

    $g.Dispose()
    $bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Created: $outFile (${w}x${h})"
}

Make-Image 250 175 'C:\Github\Powermanagment\assets\images\small.png'
Make-Image 500 350 'C:\Github\Powermanagment\assets\images\large.png'
Write-Host "Done!"
