# Pi Desktop — NSIS wizard customization
#
# electron-builder includes this file in the shared header, before MUI2 builds
# the wizard pages, so the MUI_* defines below change the real installer UI.
# The macros are called by electron-builder's own NSIS templates:
#   customWelcomePage -> assistedInstaller.nsh, before the install-mode page
#   customHeader      -> top level of installer.nsi, after the pages are inserted

# --- Palette ----------------------------------------------------------------
# The wizard keeps the app's neutral canvas instead of the system grey. Both
# values are deliberately symmetric greys, so they read the same whichever
# byte order SetCtlColors uses.
!define MUI_BGCOLOR "FFFFFF"
!define MUI_TEXTCOLOR "242424"

# --- Wizard copy ------------------------------------------------------------
# electron-builder's assisted wizard has no welcome page, so the branded
# 164x314 sidebar would only appear at the very end. Inserting the stock MUI
# welcome page makes the artwork the first screen the user sees.
!define MUI_WELCOMEPAGE_TITLE "欢迎使用 Pi Desktop"
!define MUI_WELCOMEPAGE_TEXT "为 Pi 编码智能体打造的原生桌面界面。$\r$\nA native desktop for the Pi coding agent.$\r$\n$\r$\n点击“下一步”开始安装。 / Click Next to continue."

!macro customWelcomePage
  # The first screen is where the sidebar artwork belongs; the stock MUI page
  # already takes MUI_WELCOMEFINISHPAGE_BITMAP as its left-hand image.
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW PiWelcomeShow
  !insertmacro MUI_PAGE_WELCOME

  # MUI's labels use the shell dialog face. Put the app's UI face on them so
  # the first page reads as one product rather than a system dialog.
  Function PiWelcomeShow
    CreateFont $0 "Microsoft YaHei UI" "12" "700"
    SendMessage $mui.WelcomePage.Title ${WM_SETFONT} $0 1
    CreateFont $0 "Microsoft YaHei UI" "9" "400"
    SendMessage $mui.WelcomePage.Text ${WM_SETFONT} $0 1
  FunctionEnd
!macroend

# One short sentence per language; the old copy repeated the same instruction
# twice and filled three lines of the directory page.
!define MUI_DIRECTORYPAGE_TEXT_TOP "选择安装位置 / Choose install location$\r$\n将安装在所选文件夹下的「Pi Desktop」子文件夹中。$\r$\nInstalls into a “Pi Desktop” subfolder inside the folder you pick."

!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "Pi Desktop 已安装完成。$\r$\nPi Desktop is installed and ready to use.$\r$\n$\r$\n点击“完成”退出安装向导。"

# The finish page is the last impression, so it uses the same UI face as the
# welcome page. electron-builder's default branch builds the run-after-finish
# checkbox itself; this macro keeps that part identical.
!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif

  !define MUI_PAGE_CUSTOMFUNCTION_SHOW PiFinishShow
  !insertmacro MUI_PAGE_FINISH

  Function PiFinishShow
    CreateFont $0 "Microsoft YaHei UI" "12" "700"
    SendMessage $mui.FinishPage.Title ${WM_SETFONT} $0 1
    CreateFont $0 "Microsoft YaHei UI" "9" "400"
    SendMessage $mui.FinishPage.Text ${WM_SETFONT} $0 1
  FunctionEnd
!macroend

# --- Branding ---------------------------------------------------------------
# common.nsh sets a plain "Pi Desktop 0.11.5" footer; keep the mark visible on
# every page of the wizard.
!macro customHeader
  BrandingText "Pi Desktop  ${VERSION}"
!macroend
