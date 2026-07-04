# pick_file.ps1 -- native open-file / pick-folder dialog, forced to the foreground.
#
# ASCII-ONLY BY DESIGN. Windows PowerShell 5.1 reads a .ps1 file using the system ANSI
# code page (Big5 on zh-TW) unless the file has a UTF-8 BOM. A UTF-8-no-BOM file with
# Chinese string literals therefore fails to PARSE (mis-decoded quotes break the tokenizer),
# and the script never runs. To stay robust against editors/tools that strip the BOM, this
# file contains NO non-ASCII characters. Any Chinese dialog captions are passed in as
# parameters (-Title / -FolderLabel) from training_server.js, whose UTF-8 command string is
# received by PowerShell as UTF-16 argv and is safe.
#
# Why this exists: the training board is a node server (a background process). When the user
# clicks "browse" from the browser (the foreground app), node opens this WinForms dialog.
# Windows foreground-lock forbids a background process from stealing the foreground, so the
# dialog opens BEHIND the browser and the user thinks nothing happened (it leaves a zombie
# process blocked in ShowDialog). A TopMost owner form does NOT help the Vista+ IFileDialog,
# and a WinForms Timer does not tick inside ShowDialog's modal loop.
#
# Working fix: before ShowDialog, start a background .NET thread that polls for this process's
# dialog window; once it appears, use AttachThreadInput to briefly attach our thread to the
# CURRENT foreground window's thread, which grants the right to call SetForegroundWindow and
# pull the dialog to the top. A background thread is unaffected by the modal loop, so it runs.
# (Verified: found=yes, SetForegroundWindow=True, dialog holds the foreground.)
#
# Invoked by training_server.js via -Command "& 'pick_file.ps1' ..." (NOT -File: node on
# Windows mangles backslashes in the -File path argument).
# On OK -> writes the chosen path to stdout; on Cancel -> writes an empty string.

param(
  [string]$InitialDir = "",
  [ValidateSet('file','folder')][string]$Mode = 'file',
  [string]$Title = "",
  [string]$FolderLabel = "Select this folder"
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
public class FgHelper {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  delegate bool EnumProc(IntPtr h, IntPtr p);

  static IntPtr _found;
  static uint _pid;
  static bool EnumCb(IntPtr h, IntPtr p) {
    uint wp; GetWindowThreadProcessId(h, out wp);
    if (wp == _pid && IsWindowVisible(h)) {
      StringBuilder sb = new StringBuilder(64);
      if (GetWindowText(h, sb, 64) > 0) { _found = h; return false; } // our only visible captioned window = the dialog
    }
    return true;
  }
  static IntPtr FindDialog(uint pid) { _found = IntPtr.Zero; _pid = pid; EnumWindows(EnumCb, IntPtr.Zero); return _found; }

  static void Force(IntPtr h) {
    IntPtr HWND_TOPMOST = new IntPtr(-1), HWND_NOTOPMOST = new IntPtr(-2);
    uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001;
    IntPtr fg = GetForegroundWindow();
    uint dummy; uint fgThread = GetWindowThreadProcessId(fg, out dummy);
    uint me = GetCurrentThreadId();
    AttachThreadInput(me, fgThread, true);
    SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);   // rise above everything
    SetWindowPos(h, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE); // drop back to normal layer (already on top)
    BringWindowToTop(h);
    SetForegroundWindow(h);
    AttachThreadInput(me, fgThread, false);
  }

  // background thread: poll for the dialog, then pull it to the foreground; wait up to ~12s
  public static void Begin(uint pid) {
    Thread t = new Thread(delegate() {
      for (int i = 0; i < 120; i++) {
        Thread.Sleep(100);
        IntPtr h = FindDialog(pid);
        if (h != IntPtr.Zero) { Force(h); return; }
      }
    });
    t.IsBackground = true;
    t.Start();
  }
}
"@

[FgHelper]::Begin([uint32][System.Diagnostics.Process]::GetCurrentProcess().Id)

$f = New-Object System.Windows.Forms.OpenFileDialog
$f.RestoreDirectory = $true
if ($Mode -eq 'folder') {
  # OpenFileDialog + ValidateNames=false = Explorer-style folder picker (FolderBrowserDialog is the old tree UI).
  # User walks into the target folder and clicks Open; we take the dirname of FileName.
  if ($Title) { $f.Title = $Title }
  $f.ValidateNames = $false
  $f.CheckFileExists = $false
  $f.CheckPathExists = $true
  $f.FileName = $FolderLabel
} else {
  if ($Title) { $f.Title = $Title } else { $f.Title = 'Select video' }
  $f.Filter = 'Video|*.mp4;*.mov;*.mkv;*.avi;*.flv;*.webm;*.m4v|All files|*.*'
}
if ($InitialDir -and (Test-Path -LiteralPath $InitialDir)) { $f.InitialDirectory = $InitialDir }

$result = $f.ShowDialog()

if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  if ($Mode -eq 'folder') {
    [Console]::Out.Write([System.IO.Path]::GetDirectoryName($f.FileName))
  } else {
    [Console]::Out.Write($f.FileName)
  }
}
