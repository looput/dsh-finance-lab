#!/usr/bin/env python3
"""
Chart export utilities

Helper functions for exporting charts in various formats.
"""

import matplotlib.pyplot as plt
from pathlib import Path


def export_matplotlib(fig, output_path, format='png', dpi=300, **kwargs):
    """
    Export matplotlib figure to file.
    
    Args:
        fig: matplotlib figure object
        output_path: output file path
        format: output format ('png', 'svg', 'pdf', 'jpg')
        dpi: resolution for raster formats
        **kwargs: additional arguments for savefig
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    fig.savefig(
        output_path,
        format=format,
        dpi=dpi,
        bbox_inches='tight',
        **kwargs
    )
    print(f"Chart exported to {output_path}")


def export_plotly(fig, output_path, format='html', **kwargs):
    """
    Export plotly figure to file.
    
    Args:
        fig: plotly figure object
        output_path: output file path
        format: output format ('html', 'png', 'pdf', 'svg')
        **kwargs: additional arguments for write methods
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    if format == 'html':
        fig.write_html(output_path, **kwargs)
    elif format == 'png':
        fig.write_image(output_path, **kwargs)
    elif format == 'pdf':
        fig.write_image(output_path, **kwargs)
    elif format == 'svg':
        fig.write_image(output_path, **kwargs)
    else:
        raise ValueError(f"Unsupported format: {format}")
    
    print(f"Chart exported to {output_path}")


if __name__ == "__main__":
    print("Chart export utilities loaded")
    print("Use these functions to export charts in various formats")
