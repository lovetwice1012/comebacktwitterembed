#requires -Version 5.1
<#
確認用プログラムとその子プロセスを Windows Job でまとめて管理します。
証明書などの入力は匿名パイプで渡し、一時ファイルには保存しません。
プロセスは停止状態で作成し、Job に登録してから実行します。
#>
function Initialize-XEdgeCalibrationJob {
    if ('XEdgeNative.CalibrationJob' -as [type]) { return }
    $source = @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
namespace XEdgeNative {
 public sealed class CalibrationJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long User,Job; public uint Flags; public UIntPtr Min,Max; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT Basic; public IO_COUNTERS IO; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long User,Kernel,PeriodUser,PeriodKernel; public uint Faults,Total,Active,Terminated; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUP { public int cb; public string reserved,desktop,title; public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reservedBytes; public IntPtr reservedPointer,input,output,error; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUP_EX { public STARTUP startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SECURITY_ATTRIBUTES attributes,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXTENDED_LIMIT value,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref STARTUP_EX startup,out PROCESS process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint exitCode);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint exitCode);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out ACCOUNTING info,uint length,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  IntPtr job,process; FileStream input,output;
  public uint ProcessId { get; private set; }
  static void Close(ref IntPtr value) { if(value!=IntPtr.Zero){CloseHandle(value);value=IntPtr.Zero;} }
  public static CalibrationJob Start(string executable,string arguments,string directory,string environmentBlock) {
   if(String.IsNullOrEmpty(executable)||String.IsNullOrEmpty(directory))throw new ArgumentException();
   var result=new CalibrationJob(); PROCESS info=new PROCESS(); IntPtr childIn=IntPtr.Zero,parentIn=IntPtr.Zero,parentOut=IntPtr.Zero,childOut=IntPtr.Zero;
   IntPtr attrs=IntPtr.Zero,list=IntPtr.Zero,environment=IntPtr.Zero; bool initialized=false;
   try {
    var security=new SECURITY_ATTRIBUTES { length=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),inherit=true };
    if(!CreatePipe(out childIn,out parentIn,ref security,0)||!CreatePipe(out parentOut,out childOut,ref security,0))throw new Win32Exception();
    if(!SetHandleInformation(parentIn,1,0)||!SetHandleInformation(parentOut,1,0))throw new Win32Exception();
    IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);if(size==IntPtr.Zero)throw new Win32Exception();
    attrs=Marshal.AllocHGlobal(size);if(!InitializeProcThreadAttributeList(attrs,1,0,ref size))throw new Win32Exception();initialized=true;
    list=Marshal.AllocHGlobal(IntPtr.Size*2);Marshal.WriteIntPtr(list,0,childIn);Marshal.WriteIntPtr(list,IntPtr.Size,childOut);
    if(!UpdateProcThreadAttribute(attrs,0,new IntPtr(0x00020002),list,new IntPtr(IntPtr.Size*2),IntPtr.Zero,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error(),"UpdateProcThreadAttribute");
    result.job=CreateJobObject(IntPtr.Zero,null);if(result.job==IntPtr.Zero)throw new Win32Exception();
    var limits=new EXTENDED_LIMIT();limits.Basic.Flags=0x2000;
    if(!SetInformationJobObject(result.job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))))throw new Win32Exception();
    var startup=new STARTUP_EX();startup.startup.cb=Marshal.SizeOf(typeof(STARTUP_EX));startup.startup.flags=0x100;
    startup.startup.input=childIn;startup.startup.output=childOut;startup.startup.error=childOut;startup.attributes=attrs;
    if(!String.IsNullOrEmpty(environmentBlock))environment=Marshal.StringToHGlobalUni(environmentBlock);
    var command=new StringBuilder("\""+executable+"\" "+(arguments??""));
    if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08080404,environment,directory,ref startup,out info)) { int code=Marshal.GetLastWin32Error();throw new Win32Exception(code,"CreateProcess "+code); }
    if(!AssignProcessToJobObject(result.job,info.process))throw new Win32Exception(Marshal.GetLastWin32Error(),"AssignProcessToJobObject");
    result.process=info.process;info.process=IntPtr.Zero;result.ProcessId=info.pid;
    result.input=new FileStream(new SafeFileHandle(parentIn,true),FileAccess.Write,4096,false);parentIn=IntPtr.Zero;
    result.output=new FileStream(new SafeFileHandle(parentOut,true),FileAccess.Read,4096,false);parentOut=IntPtr.Zero;
    if(ResumeThread(info.thread)==0xffffffff)throw new Win32Exception();
    return result;
   } catch { if(info.process!=IntPtr.Zero)TerminateProcess(info.process,1);result.Dispose();throw; }
   finally { Close(ref childIn);Close(ref parentIn);Close(ref parentOut);Close(ref childOut);Close(ref info.thread);Close(ref info.process);
    if(initialized)DeleteProcThreadAttributeList(attrs);if(attrs!=IntPtr.Zero)Marshal.FreeHGlobal(attrs);if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list);if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment); }
  }
  public async Task WriteAndCloseAsync(byte[] bytes) { if(input==null||bytes==null||bytes.Length>131072)throw new InvalidOperationException();try{await input.WriteAsync(bytes,0,bytes.Length).ConfigureAwait(false);await input.FlushAsync().ConfigureAwait(false);}finally{input.Dispose();input=null;} }
  public async Task<byte[]> ReadLimitedAsync(int maximum) {
   if(output==null||maximum<1||maximum>1048576)throw new InvalidOperationException();var data=new MemoryStream();var buffer=new byte[4096];
   try { int count;while((count=await output.ReadAsync(buffer,0,buffer.Length).ConfigureAwait(false))>0){if(data.Length+count>maximum)throw new InvalidDataException();data.Write(buffer,0,count);}return data.ToArray(); }
   finally { Array.Clear(buffer,0,buffer.Length);data.Dispose(); }
  }
  public bool WaitForExit(uint milliseconds) { return process==IntPtr.Zero||WaitForSingleObject(process,milliseconds)==0; }
  public uint ExitCode { get { uint code;if(process==IntPtr.Zero||!GetExitCodeProcess(process,out code))throw new Win32Exception();return code; } }
  public void Stop() {
   if(job==IntPtr.Zero)return;if(!TerminateJobObject(job,0))throw new Win32Exception();var end=DateTime.UtcNow.AddSeconds(10);
   do { ACCOUNTING count;if(!QueryInformationJobObject(job,1,out count,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero))throw new Win32Exception();if(count.Active==0)return;Thread.Sleep(25); }while(DateTime.UtcNow<end);
   throw new TimeoutException("Calibration job did not become empty");
  }
  public void Dispose() { if(input!=null){input.Dispose();input=null;}if(output!=null){output.Dispose();output=null;}Close(ref job);Close(ref process); }
 }
}
'@
    Add-Type -TypeDefinition $source -Language CSharp -IgnoreWarnings -WarningAction SilentlyContinue -ErrorAction Stop
}
