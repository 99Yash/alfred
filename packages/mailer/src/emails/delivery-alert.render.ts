import { render } from "@react-email/render";
import { createElement } from "react";
import { DeliveryAlertEmail, type DeliveryAlertEmailProps } from "./delivery-alert";

/**
 * Render the delivery-alert email to HTML. A separate file, so the component file
 * exports only components and Fast Refresh works in the email preview.
 * Uses `createElement`, not JSX: this package compiles with the classic JSX
 * runtime, but `apps/web` type-checks it with the automatic runtime, where a
 * JSX-only `React` import is an unused local.
 */
export const renderDeliveryAlertEmail = (props: DeliveryAlertEmailProps): Promise<string> =>
  render(createElement(DeliveryAlertEmail, props));
