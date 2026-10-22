/** Decorative simple-icons SVG for inline footer marks (no a11y name / tooltip). */
export function iconMark(svg: string): string {
	return svg
		.replace("<svg ", '<svg aria-hidden="true" ')
		.replace(/<title>[^<]*<\/title>/, "");
}
