# Mooner Explorer

로컬 PC에서 Android 기기를 관리하는 Electron 데스크톱 애플리케이션입니다.

- 실행 환경: 개인 PC (Windows/macOS/Linux)
- 기기 연결: Android Debug Bridge (USB 및 무선 ADB)
- 외부 서버, gharp, 배포용 컨테이너 및 GitHub Actions 사용 안 함

## 준비

- Node.js 24 이상, pnpm 11
- [Android SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools)의 `adb`
  - 다음 순서로 자동 탐색합니다: 앱 설정의 경로 → `ADB_PATH` → `ANDROID_HOME`/`ANDROID_SDK_ROOT` → OS별 기본 SDK 위치 → `PATH`
- 기기: 개발자 옵션 › USB 디버깅(또는 무선 디버깅)을 켜고, 처음 연결할 때 기기에 뜨는 허용 창에서 허용

## 실행

```sh
pnpm install
pnpm start        # 앱 실행 (첫 실행 때 Electron 바이너리를 내려받습니다)
pnpm dev          # 개발자 도구 표시 + 파일 감시 (renderer/preload는 창 새로 고침, main/adb는 앱 재시작)
pnpm check        # 문법 검사 + 단위 테스트
```

## 기능

| 탭 | 내용 |
| --- | --- |
| 개요 | 제조사·모델·Android 버전·보안 패치, 배터리, 저장공간, 해상도, Wi-Fi IP, 가동 시간. 무선 ADB 전환, 재부팅(일반/리커버리/부트로더) |
| 파일 | 폴더 탐색, 바로 가기, 이름 필터, 다중 선택(Ctrl/Shift), 업로드(버튼 또는 끌어다 놓기), 다운로드, 새 폴더, 이름 변경, 삭제, 더블클릭으로 PC에서 열기. 단축키: Enter, Backspace, F2, F5, Delete, Ctrl+A |
| 앱 | 사용자/시스템/전체 패키지 목록과 검색, 버전·SDK·설치 출처, 실행, 강제 종료, APK 추출, 활성/비활성, 데이터 삭제, 제거, APK 설치(버튼 또는 끌어다 놓기) |
| 화면 | 스크린샷과 자동 새로 고침, 클릭=탭·드래그=스와이프, 하드웨어 키, 텍스트 입력, PNG 저장 |
| 로그캣 | 실시간 스트리밍, 레벨·텍스트 필터, 자동 스크롤, 기기 버퍼 비우기, 파일로 저장 |
| 셸 | `adb shell` 명령 실행(작업 폴더 유지, 기록, 중지) |

사이드바의 **무선 연결**에서 IP 연결과 Android 11+ 페어링 코드 연결을, **설정**에서 adb 경로 지정과 adb 서버 재시작을 할 수 있습니다.

## 구조

```
src/main.js         Electron 메인 프로세스: 창, IPC 핸들러, 파일 대화상자
src/adb.js          adb 실행과 출력 파서 (Electron 의존성 없음, 단위 테스트 대상)
src/preload.cjs     렌더러에 노출하는 최소 API (contextIsolation + sandbox)
src/renderer/       빌드 단계 없는 HTML/CSS/JS UI
tests/              node:test 단위 테스트
```

## 참고 사항

- Windows용 `adb pull`은 한글 등 비ASCII 로컬 경로를 다루지 못합니다(폴더 이름이 잘리거나 저장 실패). 그래서 다운로드는 `adb exec-out cat`으로 받아 Node가 직접 쓰고, 업로드는 대상 이름을 항상 명시합니다. 수정 시각은 보존됩니다.
- 셸 탭은 명령을 하나씩 실행하는 방식이라 `vi`, `top`처럼 화면을 계속 갱신하는 대화형 명령은 지원하지 않습니다.
- 화면 탭은 스크린샷 기반이라 실시간 미러링이 아닙니다(최소 1초 간격).
