/** A stand-in contracts package: the shared identity capabilities are qualified by. */

export interface Renderer {
    render(layout: string): Promise<string>
}

export interface AdvancedRenderer extends Renderer {
    renderFast(layout: string): Promise<string>
}
