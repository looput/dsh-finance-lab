#!/usr/bin/env python3
"""
Data processing utilities for data visualization

Common data cleaning and preparation functions.
"""

import pandas as pd
import numpy as np


def clean_data(df):
    """
    Basic data cleaning: remove duplicates, handle missing values.
    
    Args:
        df: pandas DataFrame
        
    Returns:
        Cleaned DataFrame
    """
    df = df.copy()
    df = df.drop_duplicates()
    df = df.dropna()
    return df


def prepare_time_series(df, date_column, value_column):
    """
    Prepare data for time series visualization.
    
    Args:
        df: pandas DataFrame
        date_column: name of date column
        value_column: name of value column
        
    Returns:
        DataFrame sorted by date
    """
    df = df.copy()
    df[date_column] = pd.to_datetime(df[date_column])
    df = df.sort_values(date_column)
    return df[[date_column, value_column]]


def aggregate_by_category(df, category_column, value_column, agg_func='sum'):
    """
    Aggregate data by category.
    
    Args:
        df: pandas DataFrame
        category_column: name of category column
        value_column: name of value column
        agg_func: aggregation function ('sum', 'mean', 'count', etc.)
        
    Returns:
        Aggregated DataFrame
    """
    return df.groupby(category_column)[value_column].agg(agg_func).reset_index()


def normalize_data(series):
    """
    Normalize data to 0-1 range.
    
    Args:
        series: pandas Series or numpy array
        
    Returns:
        Normalized array
    """
    min_val = series.min()
    max_val = series.max()
    if max_val == min_val:
        return np.zeros_like(series)
    return (series - min_val) / (max_val - min_val)


if __name__ == "__main__":
    # Example usage
    print("Data processing utilities loaded")
    print("Use these functions to prepare data for visualization")
