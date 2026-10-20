/**
 * Declarações mínimas da API do Chrome usadas pela extensão.
 *
 * O pacote `@types/chrome` não estava disponível no ambiente de build, então
 * esta declarado cobre apenas a superfície realmente utilizada — o que também
 * serve como documentação do que a extensão depende do navegador.
 */

declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      tab?: tabs.Tab
      id?: string
    }

    const onInstalled: {
      addListener(callback: (details: { reason: string }) => void): void
    }
    const onStartup: {
      addListener(callback: () => void): void
    }
    const onMessage: {
      addListener<T = unknown>(
        callback: (
          message: T,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void
    }

    interface Port {
      name: string
      postMessage(message: unknown): void
      onMessage: {
        addListener(callback: (message: unknown) => void): void
      }
      onDisconnect: {
        addListener(callback: () => void): void
      }
    }

    const onConnect: {
      addListener(callback: (port: Port) => void): void
    }

    function connect(options: { name: string }): Port

    function sendMessage(message: unknown): Promise<unknown>
    function getURL(path: string): string
    function getManifest(): { version: string; name: string }
  }

  namespace storage {
    interface StorageArea {
      get(keys: string[] | string | null): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
      remove(keys: string | string[]): Promise<void>
    }
    const local: StorageArea
    const session: StorageArea
  }

  namespace alarms {
    interface Alarm {
      name: string
      scheduledTime: number
    }
    const onAlarm: {
      addListener(callback: (alarm: Alarm) => void): void
    }
    function create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): Promise<void>
    function clear(name: string): Promise<boolean>
  }

  namespace tabs {
    interface Tab {
      id?: number
      url?: string
      title?: string
      status?: string
      active?: boolean
      windowId?: number
      /** quando a aba teve o foco pela última vez (Chrome 121+) */
      lastAccessed?: number
    }
    interface TabChangeInfo {
      status?: string
      url?: string
    }
    interface QueryInfo {
      active?: boolean
      currentWindow?: boolean
      url?: string | string[]
    }

    function query(info: QueryInfo): Promise<Tab[]>
    function get(tabId: number): Promise<Tab>
    function update(tabId: number, props: { url?: string; active?: boolean }): Promise<Tab>
    function sendMessage(tabId: number, message: unknown): Promise<unknown>
    function captureVisibleTab(windowId?: number): Promise<string>

    const onUpdated: {
      addListener(
        callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void,
      ): void
      removeListener(callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void): void
    }
  }

  namespace scripting {
    interface InjectionTarget {
      tabId: number
      allFrames?: boolean
    }
    function executeScript(injection: {
      target: InjectionTarget
      files: string[]
    }): Promise<unknown>
  }

  namespace sidePanel {
    function setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>
    function open(options: { windowId?: number; tabId?: number }): Promise<void>
  }

  namespace action {
    const onClicked: { addListener(callback: (tab: tabs.Tab) => void): void }
  }

  namespace webNavigation {
    interface NavigationEvent {
      tabId: number
      url: string
      frameId: number
      timeStamp: number
      transitionType?: string
    }
    const onCommitted: {
      addListener(callback: (details: NavigationEvent) => void): void
      removeListener(callback: (details: NavigationEvent) => void): void
    }
    const onCompleted: {
      addListener(callback: (details: NavigationEvent) => void): void
      removeListener(callback: (details: NavigationEvent) => void): void
    }
  }
}
