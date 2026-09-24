#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shlobj.h>
#include <stdio.h>
#include <wchar.h>

#define IDR_BETA_SCRIPT 101

static int write_embedded_script(const wchar_t *path) {
    HRSRC resource = FindResourceW(
        NULL,
        MAKEINTRESOURCEW(IDR_BETA_SCRIPT),
        RT_RCDATA
    );
    if (!resource) return 0;

    HGLOBAL loaded = LoadResource(NULL, resource);
    if (!loaded) return 0;

    DWORD size = SizeofResource(NULL, resource);
    const void *data = LockResource(loaded);
    if (!data || size == 0) return 0;

    HANDLE file = CreateFileW(
        path,
        GENERIC_WRITE,
        FILE_SHARE_READ,
        NULL,
        CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        NULL
    );
    if (file == INVALID_HANDLE_VALUE) return 0;

    DWORD written = 0;
    BOOL ok = WriteFile(
        file,
        data,
        size,
        &written,
        NULL
    );
    CloseHandle(file);

    return ok && written == size;
}

static int try_launch(
    const wchar_t *command
) {
    STARTUPINFOW startup;
    PROCESS_INFORMATION process;

    ZeroMemory(&startup, sizeof(startup));
    ZeroMemory(&process, sizeof(process));
    startup.cb = sizeof(startup);

    wchar_t buffer[4096];
    wcsncpy_s(
        buffer,
        4096,
        command,
        _TRUNCATE
    );

    BOOL ok = CreateProcessW(
        NULL,
        buffer,
        NULL,
        NULL,
        FALSE,
        CREATE_NO_WINDOW,
        NULL,
        NULL,
        &startup,
        &process
    );

    if (!ok) return 0;

    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return 1;
}

static int launch_python(
    const wchar_t *script_path
) {
    wchar_t command[4096];

    swprintf_s(
        command,
        4096,
        L"pyw.exe -3 \"%ls\"",
        script_path
    );
    if (try_launch(command)) return 1;

    swprintf_s(
        command,
        4096,
        L"py.exe -3 \"%ls\"",
        script_path
    );
    if (try_launch(command)) return 1;

    swprintf_s(
        command,
        4096,
        L"pythonw.exe \"%ls\"",
        script_path
    );
    if (try_launch(command)) return 1;

    swprintf_s(
        command,
        4096,
        L"python.exe \"%ls\"",
        script_path
    );
    if (try_launch(command)) return 1;

    return 0;
}

int WINAPI wWinMain(
    HINSTANCE instance,
    HINSTANCE previous,
    PWSTR command_line,
    int show
) {
    (void)instance;
    (void)previous;
    (void)command_line;
    (void)show;

    wchar_t local_app_data[MAX_PATH];
    if (FAILED(SHGetFolderPathW(
        NULL,
        CSIDL_LOCAL_APPDATA,
        NULL,
        SHGFP_TYPE_CURRENT,
        local_app_data
    ))) {
        MessageBoxW(
            NULL,
            L"Could not locate your Local AppData folder.",
            L"CosmicV EdgeCrunch Beta",
            MB_OK | MB_ICONERROR
        );
        return 1;
    }

    wchar_t app_dir[MAX_PATH];
    wchar_t beta_dir[MAX_PATH];
    wchar_t script_path[MAX_PATH];

    swprintf_s(
        app_dir,
        MAX_PATH,
        L"%ls\\GPTCleanerCosmicV",
        local_app_data
    );
    CreateDirectoryW(app_dir, NULL);

    swprintf_s(
        beta_dir,
        MAX_PATH,
        L"%ls\\beta",
        app_dir
    );
    CreateDirectoryW(beta_dir, NULL);

    swprintf_s(
        script_path,
        MAX_PATH,
        L"%ls\\CosmicVEdgeCrunchBeta.py",
        beta_dir
    );

    if (!write_embedded_script(script_path)) {
        MessageBoxW(
            NULL,
            L"The embedded beta script could not be extracted.",
            L"CosmicV EdgeCrunch Beta",
            MB_OK | MB_ICONERROR
        );
        return 2;
    }

    if (!launch_python(script_path)) {
        MessageBoxW(
            NULL,
            L"Python could not be found.\n\n"
            L"This lightweight beta expects Python to already be installed. "
            L"It tries pyw.exe, py.exe, pythonw.exe, and python.exe.",
            L"CosmicV EdgeCrunch Beta",
            MB_OK | MB_ICONERROR
        );
        return 3;
    }

    return 0;
}
