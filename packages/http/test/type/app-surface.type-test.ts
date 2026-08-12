// Compile-only fixture for the root transport app. `App` is the Eden contract,
// so both the value and type must stay precise and must describe each other.
import { app, type App } from "@alfred/http";

type IsAny<T> = 0 extends 1 & T ? true : false;

export const appValueIsNotAny: IsAny<typeof app> = false;
export const appTypeIsNotAny: IsAny<App> = false;
export const valueUsesAppType: App = app;
export const appTypeUsesValue: typeof app = valueUsesAppType;
