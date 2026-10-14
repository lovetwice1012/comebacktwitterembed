# この補助ファイルは配布物のハッシュ検証後にだけ読み込んでください。
# 通知情報を読むための、作業用Firefoxを準備します。
# Firefoxのコピーで読み取り処理を行い、終了時には作業用の子プロセスもまとめて片付けます。
# Windows Jobという標準機能で管理し、処理中の秘密情報はファイル保存用の結果にだけ渡します。

function Initialize-XSetupReaderJob {
    if ('XSetupNative.ReaderJob' -as [type]) { return }
    # Windows標準APIだけを使います。外部実行ファイル、Node.js、Pythonは必要ありません。
    # ブラウザーを一時停止状態で作り、Jobへ入れてから動かすため、子プロセスも管理下に入ります。
    $nativeSource = @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Security.AccessControl;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;
namespace XSetupNative {
 public sealed class ReaderJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long User,Job; public uint Flags; public UIntPtr Min,Max; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT Basic; public IO_COUNTERS IO; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long User,Kernel,PeriodUser,PeriodKernel; public uint Faults,Total,Active,Terminated; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUP { public uint cb; public string reserved,desktop,title; public uint x,y,width,height,xChars,yChars,fill,flags; public ushort show,reservedBytes; public IntPtr reservedPointer,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public uint size;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)]public bool inherit; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct TRUST_FILE { public uint size; [MarshalAs(UnmanagedType.LPWStr)]public string path; public IntPtr file,subject; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct TRUST_DATA { public uint size; public IntPtr policy,sip; public uint ui,revocation,choice; public IntPtr file; public uint action; public IntPtr state,url; public uint flags,context; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXTENDED_LIMIT value,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out ACCOUNTING value,uint size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref STARTUP startup,out PROCESS process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string path,uint access,uint share,ref SECURITY_ATTRIBUTES attributes,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformation(string root,StringBuilder name,uint nameSize,out uint serial,out uint component,out uint flags,StringBuilder format,uint formatSize);
  [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(IntPtr handle,uint type,uint information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  [DllImport("wintrust.dll",ExactSpelling=true,SetLastError=true)] static extern int WinVerifyTrust(IntPtr window,ref Guid action,ref TRUST_DATA data);
  IntPtr job=IntPtr.Zero,process=IntPtr.Zero;
  public uint ProcessId { get; private set; }
  public static bool SupportsPrivateAcl(string path) {
   uint serial,component,flags;
   return GetVolumeInformation(Path.GetPathRoot(path),new StringBuilder(261),261,out serial,out component,out flags,new StringBuilder(261),261)&&(flags&8)!=0;
  }
  static bool HasExactPrivateAcl(SafeFileHandle handle,string userSid) {
   IntPtr owner,group,dacl,sacl,descriptor;
   if(GetSecurityInfo(handle.DangerousGetHandle(),1,4,out owner,out group,out dacl,out sacl,out descriptor)!=0)return false;
   try {
    uint size=GetSecurityDescriptorLength(descriptor);if(size==0||size>65536)return false;
    var bytes=new byte[size];Marshal.Copy(descriptor,bytes,0,(int)size);
    var security=new RawSecurityDescriptor(bytes,0);
    if((security.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0||security.DiscretionaryAcl==null||security.DiscretionaryAcl.Count!=2)return false;
    bool user=false,system=false;
    foreach(GenericAce item in security.DiscretionaryAcl){var ace=item as CommonAce;
     if(ace==null||ace.AceQualifier!=AceQualifier.AccessAllowed||ace.AceFlags!=AceFlags.None||ace.AccessMask!=0x1f01ff)return false;
     if(ace.SecurityIdentifier.Value==userSid)user=true;else if(ace.SecurityIdentifier.Value=="S-1-5-18")system=true;else return false;
    }
    return user&&system;
   }finally{LocalFree(descriptor);}
  }
  public static FileStream CreatePrivateFile(string path,string userSid) {
   IntPtr descriptor=IntPtr.Zero;uint size;
   try {
    if(!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;FA;;;SY)(A;;FA;;;"+userSid+")",1,out descriptor,out size))throw new Win32Exception();
    var attributes=new SECURITY_ATTRIBUTES();attributes.size=(uint)Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));attributes.descriptor=descriptor;
    if(!SupportsPrivateAcl(path))throw new NotSupportedException("Output volume cannot persist private ACLs");
    var handle=CreateFile(path,0x40020000,0,ref attributes,1,0x80,IntPtr.Zero);
    if(handle.IsInvalid){handle.Dispose();throw new Win32Exception();}
    try{if(!HasExactPrivateAcl(handle,userSid))throw new InvalidOperationException("Output ACL verification failed");return new FileStream(handle,FileAccess.Write,4096,false);}catch{handle.Dispose();File.Delete(path);throw;}
   }finally{if(descriptor!=IntPtr.Zero)LocalFree(descriptor);}
  }
  public static bool IsSignedMozilla(string path) {
   var file=new TRUST_FILE();file.size=(uint)Marshal.SizeOf(typeof(TRUST_FILE));file.path=path;
   IntPtr pointer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TRUST_FILE)));
   var trust=new TRUST_DATA();trust.size=(uint)Marshal.SizeOf(typeof(TRUST_DATA));trust.ui=2;trust.choice=1;trust.file=pointer;trust.action=1;trust.flags=0x1010;
   var action=new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
   try { Marshal.StructureToPtr(file,pointer,false);if(WinVerifyTrust(new IntPtr(-1),ref action,ref trust)!=0)return false;
    using(var certificate=new X509Certificate2(X509Certificate.CreateFromSignedFile(path)))return certificate.GetNameInfo(X509NameType.SimpleName,false)=="Mozilla Corporation";
   } finally { trust.action=2;WinVerifyTrust(new IntPtr(-1),ref action,ref trust);Marshal.DestroyStructure(pointer,typeof(TRUST_FILE));Marshal.FreeHGlobal(pointer); }
  }
  public static ReaderJob Start(string executable,string arguments,string directory,string environmentBlock) {
   var result=new ReaderJob(); PROCESS info=new PROCESS(); IntPtr environment=IntPtr.Zero;
   try {
    result.job=CreateJobObject(IntPtr.Zero,null); if(result.job==IntPtr.Zero)throw new Win32Exception();
    var limits=new EXTENDED_LIMIT(); limits.Basic.Flags=0x2000;
    if(!SetInformationJobObject(result.job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))))throw new Win32Exception();
    var startup=new STARTUP();startup.cb=(uint)Marshal.SizeOf(typeof(STARTUP));
    environment=Marshal.StringToHGlobalUni(environmentBlock);
    var command=new StringBuilder("\""+executable+"\" "+arguments);
    if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,false,0x08000404,environment,directory,ref startup,out info))throw new Win32Exception();
    result.process=info.process;result.ProcessId=info.pid;
    if(!AssignProcessToJobObject(result.job,info.process))throw new Win32Exception();
    if(ResumeThread(info.thread)==0xffffffff)throw new Win32Exception();
    return result;
   } catch { if(info.process!=IntPtr.Zero)TerminateProcess(info.process,1);result.Dispose();throw; }
   finally { if(info.thread!=IntPtr.Zero)CloseHandle(info.thread);if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment); }
  }
  public void Stop() {
   if(job==IntPtr.Zero)return;
   if(!TerminateJobObject(job,0))throw new Win32Exception();
   var end=DateTime.UtcNow.AddSeconds(10);
   do { ACCOUNTING count;if(!QueryInformationJobObject(job,1,out count,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero))throw new Win32Exception();if(count.Active==0)return;Thread.Sleep(25); }while(DateTime.UtcNow<end);
   throw new TimeoutException("Reader job did not become empty");
  }
  public bool WaitForExit(uint milliseconds) { if(process==IntPtr.Zero)return true;return WaitForSingleObject(process,milliseconds)==0; }
  public void Dispose() { if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;}if(process!=IntPtr.Zero){CloseHandle(process);process=IntPtr.Zero;} }
 }
}
'@
    # 5.1共通の証明書APIには新しい.NETの非推奨警告がありますが、署名検証自体はWinVerifyTrustです。
    Add-Type -TypeDefinition $nativeSource -Language CSharp -IgnoreWarnings -WarningAction SilentlyContinue -ErrorAction Stop
}

function Start-XSetupReaderJob {
    param([string] $Executable, [string] $Profile)
    Initialize-XSetupReaderJob
    $environment = [Environment]::GetEnvironmentVariables('Process')
    $items = New-Object 'Collections.Generic.List[string]'
    foreach ($name in $environment.Keys) {
        # 再起動/別profile選択/別アプリ選択用の環境値を親から持ち込ませません。
        if (-not ([string]$name).StartsWith('MOZ_', [StringComparison]::OrdinalIgnoreCase) -and
            -not ([string]$name).StartsWith('NSPR_', [StringComparison]::OrdinalIgnoreCase) -and
            -not ([string]$name).StartsWith('XRE_', [StringComparison]::OrdinalIgnoreCase) -and
            -not ([string]$name).StartsWith('XUL_', [StringComparison]::OrdinalIgnoreCase) -and
            -not ([string]$name).StartsWith('SELECTABLE_PROFILE_RESET_', [StringComparison]::OrdinalIgnoreCase) -and
            @('APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP') -notcontains [string]$name -and -not ([string]$name).StartsWith('=')) {
            $items.Add(([string]$name + '=' + [string]$environment[$name]))
        }
    }
    $work = [IO.Path]::GetDirectoryName($Profile)
    $roaming = [IO.Path]::Combine($work, 'runtime-roaming')
    $local = [IO.Path]::Combine($work, 'runtime-local')
    $temporary = [IO.Path]::Combine($work, 'runtime-temp')
    foreach ($path in @($roaming, $local, $temporary)) { Assert-SafePath $path; $null = [IO.Directory]::CreateDirectory($path) }
    $items.Add(('APPDATA=' + $roaming)); $items.Add(('LOCALAPPDATA=' + $local))
    $items.Add(('TEMP=' + $temporary)); $items.Add(('TMP=' + $temporary))
    foreach ($pair in @('MOZ_DISABLE_NONLOCAL_CONNECTIONS=1',
        'MOZ_CRASHREPORTER_DISABLE=1', 'MOZ_CRASHREPORTER_NO_REPORT=1', 'MOZ_HEADLESS=1', 'MOZ_NO_REMOTE=1')) { $items.Add($pair) }
    $items.Sort([StringComparer]::OrdinalIgnoreCase)
    $block = ($items -join [char]0) + [char]0 + [char]0
    # リモート制御関連の引数は付けません。設定ファイル側でもMarionetteを無効にします。
    $arguments = (@('-headless', '-offline', '-no-remote', '-profile', $Profile, 'about:blank') |
        ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
    return [XSetupNative.ReaderJob]::Start($Executable, $arguments, [IO.Path]::GetDirectoryName($Executable), $block)
}

function Copy-XSetupFirefoxApplication {
    param([string] $Executable, [string] $Destination)
    Initialize-XSetupReaderJob
    Assert-SafePath $Executable
    if (-not [XSetupNative.ReaderJob]::IsSignedMozilla($Executable)) {
        throw 'X_SETUP_FIREFOX_SIGNATURE_INVALID: 公式Firefoxのfirefox.exeを選び直してください。選択したファイルの発行元を確認できませんでした。'
    }
    $source = [IO.Path]::GetDirectoryName($Executable)
    # 独自AutoConfigや配布ポリシーをコピーして実行しないため、改変アプリは対象外にします。
    foreach ($entry in [IO.Directory]::GetFiles($source)) {
        if ([IO.Path]::GetExtension($entry) -ieq '.cfg') { throw 'X_SETUP_FIREFOX_CUSTOM_CONFIG: 標準設定の公式Firefoxをご利用ください。選択したFirefoxには独自の設定が含まれています。' }
    }
    if ([IO.Directory]::Exists([IO.Path]::Combine($source, 'distribution'))) {
        throw 'X_SETUP_FIREFOX_CUSTOM_CONFIG: 標準設定の公式Firefoxをご利用ください。選択したFirefoxには配布元独自の設定が含まれています。'
    }
    $prefDirectory = [IO.Path]::Combine($source, 'defaults', 'pref')
    if ([IO.Directory]::Exists($prefDirectory)) {
        Assert-SafePath $prefDirectory
        foreach ($entry in [IO.Directory]::GetFiles($prefDirectory)) {
            if ([IO.Path]::GetFileName($entry) -ine 'channel-prefs.js') {
                throw 'X_SETUP_FIREFOX_CUSTOM_CONFIG: 標準設定の公式Firefoxをご利用ください。選択したFirefoxには独自の起動設定が含まれています。'
            }
        }
    }
    $null = [IO.Directory]::CreateDirectory($Destination)
    $queue = New-Object 'Collections.Generic.Queue[string]'
    $queue.Enqueue($source)
    $files = 0
    $bytes = [long]0
    while ($queue.Count -gt 0) {
        $directory = $queue.Dequeue()
        Assert-SafePath $directory
        foreach ($entry in [IO.Directory]::GetFileSystemEntries($directory)) {
            Assert-SafePath $entry
            $relative = $entry.Substring($source.Length).TrimStart([char]'\')
            $target = [IO.Path]::Combine($Destination, $relative)
            Assert-SafePath $target
            $attributes = [IO.File]::GetAttributes($entry)
            if ($attributes -band [IO.FileAttributes]::Directory) {
                $null = [IO.Directory]::CreateDirectory($target)
                $queue.Enqueue($entry)
            }
            else {
                $files++
                $bytes += (New-Object IO.FileInfo($entry)).Length
                if ($files -gt 6000 -or $bytes -gt 2147483648) { throw 'X_SETUP_FIREFOX_COPY_LIMIT: 対応するFirefoxの版を配布元へご確認ください。このFirefoxは、読み取り用に準備できる大きさやファイル数を超えています。' }
                [IO.File]::Copy($entry, $target, $false)
            }
        }
    }
    $copy = [IO.Path]::Combine($Destination, [IO.Path]::GetFileName($Executable))
    if (-not [XSetupNative.ReaderJob]::IsSignedMozilla($copy)) { throw 'X_SETUP_FIREFOX_COPY_INVALID: 公式Firefoxを選び、ディスクの空き容量を確認してからお試しください。読み取り用コピーの発行元を確認できませんでした。' }
    return $copy
}

function Write-XSetupReaderConfiguration {
    param([string] $Application, [string] $Profile, [string] $ResultPath, [string] $Uaid)
    # 原アプリや原プロファイルには書きません。今回作ったprivateコピー内の設定だけです。
    $preferences = [ordered]@{
        'marionette.enabled' = $false; 'remote.enabled' = $false
        'dom.push.enabled' = $false; 'dom.push.loglevel' = 'Error'
        'network.offline' = $true; 'network.manage-offline-status' = $false
        'network.disable.non-local-connections' = $true
        'toolkit.telemetry.enabled' = $false; 'toolkit.telemetry.unified' = $false
        'datareporting.healthreport.uploadEnabled' = $false; 'datareporting.policy.dataSubmissionEnabled' = $false
        'app.update.auto' = $false; 'app.update.enabled' = $false; 'app.update.disabledForTesting' = $true
        'browser.search.update' = $false; 'browser.safebrowsing.update.enabled' = $false
        'extensions.update.enabled' = $false; 'extensions.getAddons.cache.enabled' = $false
        'browser.startup.page' = 0; 'browser.startup.homepage' = 'about:blank'
        'browser.shell.checkDefaultBrowser' = $false; 'browser.startup.homepage_override.mstone' = 'ignore'
        'startup.homepage_welcome_url' = 'about:blank'; 'startup.homepage_welcome_url.additional' = ''
        'browser.newtabpage.enabled' = $false; 'browser.newtabpage.activity-stream.telemetry' = $false
        'browser.newtabpage.activity-stream.feeds.telemetry' = $false; 'browser.ml.enable' = $false
        'browser.region.network.url' = ''; 'browser.region.update.enabled' = $false
        'network.captive-portal-service.enabled' = $false; 'network.connectivity-service.enabled' = $false
        'dom.push.userAgentID' = $Uaid
    }
    $lines = New-Object 'Collections.Generic.List[string]'
    foreach ($name in $preferences.Keys) {
        $lines.Add(('user_pref(' + (ConvertTo-Json -InputObject $name -Compress) + ',' +
            (ConvertTo-Json -InputObject $preferences[$name] -Compress) + ');'))
    }
    Write-XSetupNewText ([IO.Path]::Combine($Profile, 'user.js')) ($lines -join "`n")
    $prefDirectory = [IO.Path]::Combine($Application, 'defaults', 'pref')
    $null = [IO.Directory]::CreateDirectory($prefDirectory)
    $prefText = 'pref("general.config.filename","x-notification-export.cfg");' + "`n" +
        'pref("general.config.obscure_value",0);' + "`n" + 'pref("general.config.sandbox_enabled",false);'
    Write-XSetupNewText ([IO.Path]::Combine($prefDirectory, 'x-notification-export.js')) $prefText
    $readerPath = [IO.Path]::Combine($script:PackageRoot, 'Read-PushSubscription.js')
    Assert-SafePath $readerPath
    $readerBody = [IO.File]::ReadAllText($readerPath, $script:Utf8)
    $configuration = [ordered]@{ uaid = $Uaid; expectedProfilePath = $Profile }
    $configJson = ConvertTo-Json -InputObject $configuration -Compress
    $resultJson = ConvertTo-Json -InputObject $ResultPath -Compress
    # 実行する本文は、manifestで照合済みの公開JSだけです。外部URL/任意コード指定はありません。
    $prefix = @'
// X通知の準備ツール: 今回の隔離アプリコピーだけで動作する固定抽出処理
var xSetupReaderObserver={observe:function(){
 Services.obs.removeObserver(xSetupReaderObserver,'final-ui-startup');
 function finish(response){
  try{
   var file=Components.classes['@mozilla.org/file/local;1'].createInstance(Components.interfaces.nsIFile);
   file.initWithPath(RESULT_PATH);
   var out=Components.classes['@mozilla.org/network/file-output-stream;1'].createInstance(Components.interfaces.nsIFileOutputStream);
   out.init(file,0x8A,0x180,0);
   var writer=Components.classes['@mozilla.org/intl/converter-output-stream;1'].createInstance(Components.interfaces.nsIConverterOutputStream);
   writer.init(out,'UTF-8');writer.writeString(JSON.stringify(response));writer.close();
  }finally{Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);}
 }
 try{
  Components.utils.importGlobalProperties(['crypto','indexedDB','URL','TextEncoder']);
  var Ci=Components.interfaces;
'@
    $suffix = @'
  ReadPushSubscription(CONFIGURATION).then(finish,function(){finish({ok:false,errorCode:'X_EXPORT_READER_FAILED'});});
 }catch(error){finish({ok:false,errorCode:'X_EXPORT_READER_FAILED'});}
}};
Services.obs.addObserver(xSetupReaderObserver,'final-ui-startup');
'@
    $prefix = $prefix.Replace('RESULT_PATH', $resultJson)
    $suffix = $suffix.Replace('CONFIGURATION', $configJson)
    Write-XSetupNewText ([IO.Path]::Combine($Application, 'x-notification-export.cfg')) ($prefix + "`n" + $readerBody + "`n" + $suffix)
}

