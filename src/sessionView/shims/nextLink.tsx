/**
 * IDE substitute for `next/link`.
 *
 * A plain <a>: in-app hrefs ("/sessions", "/runs/…") post a `nav` message to
 * the extension host, which opens the dashboard externally; absolute URLs do
 * the same. We never let the webview itself navigate.
 */
import { createElement, type AnchorHTMLAttributes, type ReactNode } from "react";
import { webBase } from "./kronyxApi";

declare global {
	// eslint-disable-next-line no-var
	var __kronyxPost: ((msg: unknown) => void) | undefined;
}

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
	href: string;
	children?: ReactNode;
}

export default function Link({ href, children, onClick, ...rest }: LinkProps) {
	return createElement(
		"a",
		{
			href: "#",
			...rest,
			onClick: (e: MouseEvent) => {
				e.preventDefault();
				onClick?.(e as never);
				const url = /^https?:/i.test(href) ? href : `${webBase()}${href.startsWith("/") ? href : `/${href}`}`;
				globalThis.__kronyxPost?.({ type: "nav", url });
			},
		},
		children,
	);
}
