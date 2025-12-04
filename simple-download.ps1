# Simple Reference Image Downloader
# Downloads 3 diverse images per product using free image service

param([switch]$Backup = $true)

$ErrorActionPreference = "Continue"

Write-Host "Reference Image Downloader" -ForegroundColor Cyan
Write-Host ("=" * 60)

# Backup existing references
if ($Backup -and (Test-Path "references")) {
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $backupPath = "references_backup_$timestamp"
    Write-Host "`nBacking up to: $backupPath" -ForegroundColor Yellow
    Copy-Item -Recurse references $backupPath
}

# Product definitions with image search seeds
$products = @(
    @{id="p1"; name="Dark Chocolate"; seeds=@(101, 102, 103)},
    @{id="p2"; name="Yoga Mat"; seeds=@(201, 202, 203)},
    @{id="p3"; name="Water Bottle"; seeds=@(301, 302, 303)},
    @{id="p4"; name="Smartwatch"; seeds=@(401, 402, 403)},
    @{id="p5"; name="Earbuds"; seeds=@(501, 502, 503)},
    @{id="p6"; name="Power Bank"; seeds=@(601, 602, 603)},
    @{id="p7"; name="Glasses"; seeds=@(701, 702, 703)},
    @{id="p8"; name="Lunch Box"; seeds=@(801, 802, 803)},
    @{id="p9"; name="Steel Bottle"; seeds=@(901, 902, 903)},
    @{id="p10"; name="Smartphone"; seeds=@(1001, 1002, 1003)},
    @{id="p11"; name="Deodorant"; seeds=@(1101, 1102, 1103)}
)

# Create references folder
New-Item -ItemType Directory -Force -Path "references" | Out-Null

$totalDownloaded = 0
$totalFailed = 0

foreach ($product in $products) {
    Write-Host "`nProcessing: $($product.name) ($($product.id))" -ForegroundColor Green
    
    $productPath = "references/$($product.id)"
    New-Item -ItemType Directory -Force -Path $productPath | Out-Null
    
    for ($i = 0; $i -lt 3; $i++) {
        $seed = $product.seeds[$i]
        $imageUrl = "https://picsum.photos/seed/$seed/800/600.jpg"
        $outputFile = "$productPath/$($product.id)_ref_$i.jpg"
        
        Write-Host "  Downloading image $($i + 1)/3..." -ForegroundColor Gray
        
        try {
            Invoke-WebRequest -Uri $imageUrl -OutFile $outputFile -UseBasicParsing -TimeoutSec 15
            
            if (Test-Path $outputFile) {
                $fileSize = (Get-Item $outputFile).Length
                $fileSizeKB = [math]::Round($fileSize / 1024, 1)
                
                if ($fileSize -gt 5120) {
                    Write-Host "  SUCCESS: $outputFile ($fileSizeKB KB)" -ForegroundColor Green
                    $totalDownloaded++
                } else {
                    Write-Host "  FAILED: File too small ($fileSizeKB KB)" -ForegroundColor Red
                    Remove-Item $outputFile -Force -ErrorAction SilentlyContinue
                    $totalFailed++
                }
            }
        }
        catch {
            Write-Host "  ERROR: $($_.Exception.Message)" -ForegroundColor Red
            $totalFailed++
        }
        
        Start-Sleep -Milliseconds 300
    }
}

Write-Host "`n" + ("=" * 60)
Write-Host "Summary:" -ForegroundColor Cyan
Write-Host "  Downloaded: $totalDownloaded images" -ForegroundColor Green
Write-Host "  Failed: $totalFailed attempts" -ForegroundColor $(if ($totalFailed -gt 0) {"Red"} else {"Gray"})

Write-Host "`nNOTE: These are PLACEHOLDER images from Lorem Picsum" -ForegroundColor Yellow
Write-Host "They are generic photos, NOT actual products!" -ForegroundColor Yellow
Write-Host "`nFor accurate detection, you need REAL product photos." -ForegroundColor Cyan
Write-Host "Options:" -ForegroundColor Cyan
Write-Host "  1. Take 3 photos of each product with your phone" -ForegroundColor White
Write-Host "  2. Search Google Images for each product, save 3 photos" -ForegroundColor White
Write-Host "  3. Use manufacturer websites for product images" -ForegroundColor White
Write-Host "`nThen replace files in references/p1/, references/p2/, etc." -ForegroundColor Cyan
