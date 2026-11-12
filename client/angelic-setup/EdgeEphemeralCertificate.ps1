#requires -Version 5.1
<#
.SYNOPSIS
設定用の一時的な接続確認に使う証明書を、メモリー内に作ります。
.DESCRIPTION
この証明書は短時間だけ localhost に使います。Windows の証明書ストアには
登録せず、ファイルにも保存しません。呼び出し元は使用後に配列を消去します。
#>
function New-XEdgeEphemeralCertificate {
    $rsa = [Security.Cryptography.RSA]::Create(2048)
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $random = New-Object byte[] 32
    $certificate = $null
    $pfx = $null; $der = $null; $success = $false
    try {
        $rng.GetBytes($random)
        $password = [Convert]::ToBase64String($random)
        $request = New-Object Security.Cryptography.X509Certificates.CertificateRequest(
            'CN=localhost', $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256,
            [Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $names = New-Object Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder
        $names.AddDnsName('localhost')
        $names.AddIpAddress([Net.IPAddress]::Loopback)
        $request.CertificateExtensions.Add($names.Build())
        $request.CertificateExtensions.Add((New-Object Security.Cryptography.X509Certificates.X509BasicConstraintsExtension($false,$false,0,$true)))
        $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1), [DateTimeOffset]::UtcNow.AddMinutes(10))
        $pfx = $certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password)
        $der = $certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert)
        $success = $true
        return [pscustomobject]@{ pfx = $pfx; password = $password; certificate = $der }
    } finally {
        if (-not $success) {
            if ($null -ne $pfx) { [Array]::Clear($pfx, 0, $pfx.Length) }
            if ($null -ne $der) { [Array]::Clear($der, 0, $der.Length) }
        }
        [Array]::Clear($random, 0, $random.Length)
        if ($null -ne $certificate) { $certificate.Dispose() }
        $rng.Dispose(); $rsa.Dispose()
    }
}
