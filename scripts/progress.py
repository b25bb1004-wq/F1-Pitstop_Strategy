import pandas as pd
import glob

total_races = 0
for file in glob.glob('../data/*.csv'):
    df = pd.read_csv(file, low_memory=False)
    total_races += df['year'].nunique()

print(total_races)
