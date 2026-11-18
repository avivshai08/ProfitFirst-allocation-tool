# Lists the catalog items (פריטים) in your SUMIT account with their ID, so you can find
# the allocation tool's item (25 ILS + VAT). Read-only: it changes nothing in SUMIT.
# The company ID and API key are used for this request only and are not saved anywhere.

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$companyId = (Read-Host 'SUMIT Company ID').Trim()
$apiKey = (Read-Host 'SUMIT API key').Trim()

$items = @()
$start = 0
do {
  $body = @{
    Credentials = @{ CompanyID = [long]$companyId; APIKey = $apiKey }
    Paging      = @{ StartIndex = $start; PageSize = 100 }
  } | ConvertTo-Json -Depth 3
  $res = Invoke-WebRequest -UseBasicParsing -Method Post -Uri 'https://api.sumit.co.il/accounting/incomeitems/list/' `
    -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
  $json = [Text.Encoding]::UTF8.GetString($res.RawContentStream.ToArray()) | ConvertFrom-Json
  if (-not ("$($json.Status)" -eq '0' -or "$($json.Status)" -match '^Success')) {
    Write-Host "SUMIT refused the request: $($json.UserErrorMessage) $($json.TechnicalErrorDetails)" -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
  }
  $items += $json.Data.IncomeItems
  $start += 100
} while ($json.Data.HasNextPage)

Write-Host ''
Write-Host "Found $($items.Count) items. Look for the allocation tool's item (price 25):" -ForegroundColor Cyan
$items | Sort-Object Price, Name | Format-Table @{L='ID';E={$_.ID}}, @{L='Price';E={$_.Price}}, @{L='Name';E={$_.Name}} -AutoSize | Out-String -Width 200 | Write-Host
Read-Host 'Press Enter to close'
